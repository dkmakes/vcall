// vcall 서버: 비밀번호 확인, 두 사람 연결 중개(시그널링), TURN 정보 전달
// 영상과 음성은 이 서버를 거치지 않고 두 브라우저가 직접 주고받습니다.
import { DurableObject } from "cloudflare:workers";

const MAX_FAILS = 5;                 // 이 횟수만큼 틀리면
const LOCK_MS = 15 * 60 * 1000;      // 15분 동안 막음
const REMEMBER_MS = 30 * 864e5;      // "30일 기억" 토큰
const SESSION_MS = 12 * 36e5;        // 기억 안 함: 12시간
const STALE_MS = 35 * 1000;          // 35초 동안 응답 없는 연결은 끊긴 것으로 봄

const te = new TextEncoder();

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey(
    "raw", te.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, te.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  const x = te.encode(a);
  const y = te.encode(b);
  if (x.byteLength !== y.byteLength) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}

async function checkPassword(env, given) {
  const a = await hmacHex("vcall-pw", String(given ?? ""));
  const b = await hmacHex("vcall-pw", String(env.ROOM_PASSWORD));
  return safeEqual(a, b);
}

// 토큰 = 만료시각.서명 (비밀번호를 바꾸면 기존 토큰은 모두 무효)
async function makeToken(env, ms) {
  const exp = Date.now() + ms;
  const sig = await hmacHex(env.ROOM_PASSWORD, "vcall-token:" + exp);
  return { token: `${exp}.${sig}`, exp };
}

async function verifyToken(env, token) {
  if (!env.ROOM_PASSWORD || !token) return false;
  const [expStr, sig] = String(token).split(".");
  const exp = Number(expStr);
  if (!exp || !sig || exp < Date.now()) return false;
  return safeEqual(sig, await hmacHex(env.ROOM_PASSWORD, "vcall-token:" + exp));
}

function isAllowedOrigin(origin, env) {
  if (!origin) return false;
  const list = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (list.includes(origin)) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

function withHeaders(res, extra) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return new Response(res.body, { status: res.status, headers: h });
}

async function getIceServers(env) {
  const list = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return list;
  try {
    const r = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: 86400 }),
      }
    );
    if (!r.ok) return list;
    const d = await r.json();
    let servers = d.iceServers;
    if (!Array.isArray(servers)) servers = servers ? [servers] : [];
    for (const s of servers) {
      // 53번 포트 주소는 브라우저에서 막히는 경우가 많아 뺍니다
      const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => u && !/:53(\?|$)/.test(u));
      if (urls.length) list.push({ ...s, urls });
    }
  } catch (e) {
    // TURN을 못 받아도 STUN만으로 계속 진행
  }
  return list;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const allowed = isAllowedOrigin(origin, env);
    const cors = allowed ? corsHeaders(origin) : { Vary: "Origin" };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: allowed ? 204 : 403, headers: cors });
    }
    if (url.pathname === "/") {
      return new Response("vcall server ok", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    if (!allowed) return json({ error: "origin_not_allowed" }, 403, cors);
    if (!env.ROOM_PASSWORD) return json({ error: "not_configured" }, 500, cors);

    const room = env.ROOM.get(env.ROOM.idFromName("main"));

    if (url.pathname === "/auth" && request.method === "POST") {
      return withHeaders(await room.fetch(request), cors);
    }

    if (url.pathname === "/ice") {
      const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      if (!(await verifyToken(env, token))) return json({ error: "unauthorized" }, 401, cors);
      return json({ iceServers: await getIceServers(env) }, 200, cors);
    }

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") return json({ error: "expected_websocket" }, 426, cors);
      if (!(await verifyToken(env, url.searchParams.get("token")))) {
        return new Response("unauthorized", { status: 401 });
      }
      return room.fetch(request);
    }

    return json({ error: "not_found" }, 404, cors);
  },
};

// 통화방 하나 (최대 2명)
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // 브라우저가 10초마다 보내는 "ping"에 서버를 깨우지 않고 자동으로 "pong" 응답
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/auth") return this.auth(request);
    if (url.pathname === "/ws") return this.join(url);
    return new Response("not found", { status: 404 });
  }

  async auth(request) {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const key = "fail:" + ip;
    const now = Date.now();
    let rec = (await this.ctx.storage.get(key)) || { n: 0, first: now, until: 0 };
    if (rec.until > now) {
      return json({ error: "locked", retryAfter: Math.ceil((rec.until - now) / 1000) }, 429);
    }
    let body = {};
    try { body = await request.json(); } catch (e) { /* 빈 요청 */ }

    if (await checkPassword(this.env, body.password)) {
      await this.ctx.storage.delete(key);
      return json(await makeToken(this.env, body.remember ? REMEMBER_MS : SESSION_MS));
    }

    if (now - rec.first > LOCK_MS) rec = { n: 0, first: now, until: 0 };
    rec.n += 1;
    if (rec.n >= MAX_FAILS) rec = { n: 0, first: now, until: now + LOCK_MS };
    await this.ctx.storage.put(key, rec);
    if (rec.until > now) return json({ error: "locked", retryAfter: Math.ceil(LOCK_MS / 1000) }, 429);
    return json({ error: "wrong_password", left: MAX_FAILS - rec.n }, 401);
  }

  join(url) {
    const cid = (url.searchParams.get("cid") || "").slice(0, 40);
    const name = (url.searchParams.get("name") || "").trim().slice(0, 30) || "Guest";
    const now = Date.now();

    // 같은 기기에서 다시 들어왔거나(새로고침) 응답이 끊긴 연결은 정리
    const live = [];
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() || {};
      const last = this.ctx.getWebSocketAutoResponseTimestamp(ws);
      const lastMs = last ? last.getTime() : a.joined || 0;
      if (a.left) continue;
      if ((cid && a.cid === cid) || now - lastMs > STALE_MS) {
        this.dropSocket(ws, 4000, "replaced");
      } else {
        live.push(ws);
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    if (live.length >= 2) {
      server.accept();
      server.send(JSON.stringify({ type: "full" }));
      server.close(4001, "full");
      return new Response(null, { status: 101, webSocket: client });
    }

    const id = crypto.randomUUID().slice(0, 8);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id, name, cid, joined: now });

    const peers = live.map((w) => {
      const a = w.deserializeAttachment() || {};
      return { id: a.id, name: a.name };
    });
    server.send(JSON.stringify({ type: "welcome", id, peers }));
    for (const w of live) this.send(w, { type: "peer-joined", id, name });

    return new Response(null, { status: 101, webSocket: client });
  }

  send(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch (e) { /* 이미 닫힘 */ }
  }

  notifyLeft(ws) {
    const a = ws.deserializeAttachment() || {};
    if (!a.id || a.left) return;
    a.left = true;
    try { ws.serializeAttachment(a); } catch (e) { /* 닫힌 소켓 */ }
    for (const other of this.ctx.getWebSockets()) {
      if (other !== ws) this.send(other, { type: "peer-left", id: a.id });
    }
  }

  dropSocket(ws, code, reason) {
    this.notifyLeft(ws);
    try { ws.close(code, reason); } catch (e) { /* 이미 닫힘 */ }
  }

  webSocketMessage(ws, message) {
    if (typeof message !== "string" || message.length > 256 * 1024) return;
    let data;
    try { data = JSON.parse(message); } catch (e) { return; }
    if (data.type !== "signal") return;
    const me = ws.deserializeAttachment() || {};
    for (const other of this.ctx.getWebSockets()) {
      if (other !== ws) this.send(other, { type: "signal", from: me.id, data: data.data });
    }
  }

  webSocketClose(ws) {
    this.notifyLeft(ws);
    try { ws.close(1000, "bye"); } catch (e) { /* 이미 닫힘 */ }
  }

  webSocketError(ws) {
    this.notifyLeft(ws);
  }
}
