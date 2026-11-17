/* dkmakes call: 1:1 화상채팅
 * 흐름: 비밀번호 → 입장 전 확인 → 통화(화면 공유, 레이저 포인터)
 * 영상/음성/화면은 WebRTC로 두 브라우저가 직접 주고받고,
 * 서버(Cloudflare Worker)는 비밀번호 확인과 처음 연결만 도와줍니다.
 */
(() => {
  'use strict';

  const API = String(window.VCALL_API || '').replace(/\/+$/, '');

  // ---------- 저장소 ----------
  const store = (area) => ({
    get(k, d) { try { const v = area.getItem('vcall.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { area.setItem('vcall.' + k, JSON.stringify(v)); } catch (e) { /* 저장 불가 */ } },
    del(k) { try { area.removeItem('vcall.' + k); } catch (e) { /* 저장 불가 */ } },
  });
  const LS = store(window.localStorage);
  const SS = store(window.sessionStorage);

  const clientId = LS.get('cid') || (() => {
    const c = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    LS.set('cid', c);
    return c;
  })();

  // ---------- 요소 (미리보기 창으로 옮겨져도 쓸 수 있게 처음에 모두 잡아 둠) ----------
  const E = {};
  document.querySelectorAll('[id]').forEach((el) => { E[el.id] = el; });

  // ---------- 상태 ----------
  const S = {
    screen: null,
    token: null,
    iceServers: null,
    name: LS.get('name', ''),
    camOn: LS.get('camOn', true),
    micOn: LS.get('micOn', true),
    localAudio: null,
    localVideo: null,
    ws: null,
    wsRetries: 0,
    leaving: false,
    partner: null,          // { id, name }
    partnerCam: true,
    pc: null,
    dc: null,
    tx: {},                 // { audio, cam, screen } 송수신기
    isOfferer: false,
    pending: [],
    sigChain: Promise.resolve(),
    remote: { audio: null, cam: null, screen: null },
    screenTrack: null,
    myShare: null,          // null | 'starting' | 'me'
    partnerShare: null,     // null | 'starting' | 'on'
    pFrame: false,
    pipWin: null,
    faceShown: LS.get('faceShown', true),
  };

  // ---------- 공통 ----------
  function show(name) {
    document.querySelectorAll('.screen').forEach((s) => { s.hidden = s.id !== 'scr-' + name; });
    S.screen = name;
  }

  let toastTimer;
  function toast(msg, ms = 3200) {
    E.toast.textContent = msg;
    E.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { E.toast.hidden = true; }, ms);
  }

  function showNet(text) { E.netText.textContent = text; E.netWarn.hidden = false; }
  function hideNet() { E.netWarn.hidden = true; }

  async function api(path, opts = {}) {
    const res = await fetch(API + path, opts);
    let data = null;
    try { data = await res.json(); } catch (e) { /* 본문 없음 */ }
    return { ok: res.ok, status: res.status, data };
  }

  function partnerName() { return (S.partner && S.partner.name) || '상대방'; }
  function initialOf(name) { return (String(name || '?').trim()[0] || '?').toUpperCase(); }
  function camLive() { return !!(S.camOn && S.localVideo); }
  const round = (n) => Math.round(n * 10000) / 10000;

  function playAll() {
    [E.remoteAudio, E.remoteCam, E.remoteCam2, E.panelFaceVideo, E.remoteScreen, E.myScreen, E.selfVideo, E.selfVideo2, E.preVideo]
      .forEach((v) => { if (v && v.srcObject) v.play().catch(() => {}); });
  }

  // ---------- 토큰 ----------
  function saveToken(token, remember) {
    S.token = token;
    if (remember) { LS.set('token', token); SS.del('token'); } else { SS.set('token', token); LS.del('token'); }
  }
  function clearToken() { S.token = null; LS.del('token'); SS.del('token'); }

  // 'ok' | 'unauthorized' | 'error'
  async function loadIce() {
    try {
      const r = await api('/ice', { headers: { Authorization: 'Bearer ' + S.token } });
      if (r.ok && r.data && r.data.iceServers) { S.iceServers = r.data.iceServers; return 'ok'; }
      if (r.status === 401) return 'unauthorized';
    } catch (e) { /* 네트워크 오류 */ }
    if (!S.iceServers) S.iceServers = [{ urls: ['stun:stun.l.google.com:19302'] }];
    return 'error';
  }

  // ---------- ① 비밀번호 ----------
  function pwError(msg) { E.pwErr.textContent = msg; E.pwErr.hidden = !msg; }

  async function submitPw(e) {
    e.preventDefault();
    const pw = E.pwInput.value;
    if (!pw) { pwError('비밀번호를 입력해 주세요.'); return; }
    E.pwBtn.disabled = true;
    pwError('');
    try {
      const r = await api('/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw, remember: E.pwRemember.checked }),
      });
      if (r.ok && r.data && r.data.token) {
        saveToken(r.data.token, E.pwRemember.checked);
        E.pwInput.value = '';
        await loadIce();
        goPrejoin();
      } else if (r.status === 429) {
        const min = Math.max(1, Math.ceil(((r.data && r.data.retryAfter) || 900) / 60));
        pwError(`여러 번 틀려서 잠시 막혔어요. ${min}분 뒤에 다시 시도해 주세요.`);
      } else if (r.status === 401) {
        pwError('비밀번호가 틀렸습니다. 다시 입력해 주세요.');
        E.pwInput.select();
      } else if (r.data && r.data.error === 'not_configured') {
        pwError('서버에 비밀번호가 아직 설정되지 않았어요.');
      } else {
        pwError('서버에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요.');
      }
    } catch (err) {
      pwError('서버에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요.');
    } finally {
      E.pwBtn.disabled = false;
    }
  }

  // ---------- ② 입장 전 확인 ----------
  async function goPrejoin() {
    show('pre');
    E.nameInput.value = S.name;
    E.preErr.hidden = true;
    E.enterBtn.disabled = false;
    updatePre();
    await acquireMedia();
    await fillDevices();
    startMeter();
  }

  function audioConstraints(id) {
    return { deviceId: id ? { ideal: id } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  }
  function videoConstraints(id) {
    return { deviceId: id ? { ideal: id } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
  }

  async function acquireMedia() {
    stopLocal();
    let stream = null;
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      const a = audioConstraints(LS.get('micId'));
      const v = videoConstraints(LS.get('camId'));
      for (const c of [{ audio: a, video: v }, { audio: a }, { video: v }]) {
        try { stream = await navigator.mediaDevices.getUserMedia(c); break; } catch (e) { /* 다음 조합 */ }
      }
    }
    S.localAudio = (stream && stream.getAudioTracks()[0]) || null;
    S.localVideo = (stream && stream.getVideoTracks()[0]) || null;
    applyTrackEnabled();
    attachLocalPreviews();
    const miss = [];
    if (!S.localVideo) miss.push('카메라');
    if (!S.localAudio) miss.push('마이크');
    if (miss.length) {
      const what = miss.length === 2 ? '카메라와 마이크를' : miss[0] + '를';
      E.preErr.textContent = `${what} 사용할 수 없어요. 브라우저 주소창 옆의 권한 설정을 확인해 주세요. 이대로 입장할 수도 있어요.`;
      E.preErr.hidden = false;
    } else {
      E.preErr.hidden = true;
    }
    updatePre();
  }

  function stopLocal() {
    [S.localAudio, S.localVideo].forEach((t) => { if (t) t.stop(); });
    S.localAudio = null;
    S.localVideo = null;
  }

  function attachLocalPreviews() {
    const s = S.localVideo ? new MediaStream([S.localVideo]) : null;
    [E.preVideo, E.selfVideo, E.selfVideo2].forEach((v) => { v.srcObject = s; });
    playAll();
  }

  function applyTrackEnabled() {
    if (S.localAudio) S.localAudio.enabled = S.micOn;
    if (S.localVideo) S.localVideo.enabled = S.camOn;
  }

  async function fillDevices() {
    let devs = [];
    try { devs = await navigator.mediaDevices.enumerateDevices(); } catch (e) { /* 지원 안 함 */ }
    fillSelect(E.camSel, devs.filter((d) => d.kind === 'videoinput'), S.localVideo && S.localVideo.getSettings().deviceId, '카메라');
    fillSelect(E.micSel, devs.filter((d) => d.kind === 'audioinput'), S.localAudio && S.localAudio.getSettings().deviceId, '마이크');
    const outs = devs.filter((d) => d.kind === 'audiooutput');
    const canSink = 'setSinkId' in HTMLMediaElement.prototype;
    if (canSink && outs.length) {
      fillSelect(E.spkSel, outs, LS.get('spkId') || 'default', '스피커');
      E.spkSel.hidden = false;
      E.spkNote.hidden = true;
    } else {
      E.spkSel.hidden = true;
      E.spkNote.hidden = false;
    }
  }

  function fillSelect(sel, list, current, label) {
    sel.innerHTML = '';
    if (!list.length) {
      sel.add(new Option(`${label} 없음`, ''));
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    list.forEach((d, i) => sel.add(new Option(d.label || `${label} ${i + 1}`, d.deviceId)));
    if (current && list.some((d) => d.deviceId === current)) sel.value = current;
  }

  async function switchDevice(kind, deviceId) {
    if (!deviceId) return;
    LS.set(kind === 'audio' ? 'micId' : 'camId', deviceId);
    const old = kind === 'audio' ? S.localAudio : S.localVideo;
    if (old) old.stop();
    try {
      const c = kind === 'audio'
        ? { audio: { ...audioConstraints(), deviceId: { exact: deviceId } } }
        : { video: { ...videoConstraints(), deviceId: { exact: deviceId } } };
      const s = await navigator.mediaDevices.getUserMedia(c);
      const t = kind === 'audio' ? s.getAudioTracks()[0] : s.getVideoTracks()[0];
      if (kind === 'audio') S.localAudio = t; else S.localVideo = t;
      applyTrackEnabled();
      attachLocalPreviews();
      if (kind === 'audio') startMeter();
      const sender = kind === 'audio' ? S.tx.audio && S.tx.audio.sender : S.tx.cam && S.tx.cam.sender;
      if (sender) await sender.replaceTrack(t);
      E.preErr.hidden = true;
    } catch (e) {
      if (kind === 'audio') S.localAudio = null; else S.localVideo = null;
      E.preErr.textContent = '선택한 장치를 사용할 수 없어요. 다른 장치를 골라 주세요.';
      E.preErr.hidden = false;
    }
    updatePre();
  }

  function updatePre() {
    E.camSwitch.classList.toggle('on', S.camOn);
    E.camSwitch.setAttribute('aria-pressed', String(S.camOn));
    E.micSwitch.classList.toggle('on', S.micOn);
    E.micSwitch.setAttribute('aria-pressed', String(S.micOn));
    E.preCamOff.hidden = camLive();
    E.preCamOff.textContent = S.localVideo ? '카메라가 꺼져 있어요' : '카메라를 사용할 수 없어요';
    E.micHint.textContent = !S.localAudio ? '마이크를 사용할 수 없어요'
      : S.micOn ? '말해 보세요. 막대가 움직이면 정상이에요.' : '마이크가 꺼져 있어요';
  }

  // 마이크 음량 막대
  let audioCtx = null;
  let meterRAF = 0;
  let meterSrc = null;
  function getAudioCtx() {
    if (!audioCtx) {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      audioCtx = new C();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  }
  function startMeter() {
    stopMeter();
    if (!S.localAudio) { E.micLevel.style.width = '0%'; return; }
    const ctx = getAudioCtx();
    if (!ctx) return;
    try {
      meterSrc = ctx.createMediaStreamSource(new MediaStream([S.localAudio]));
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      meterSrc.connect(an);
      const buf = new Uint8Array(an.fftSize);
      const loop = () => {
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const x = (buf[i] - 128) / 128; sum += x * x; }
        const level = S.micOn ? Math.min(100, Math.sqrt(sum / buf.length) * 400) : 0;
        E.micLevel.style.width = level.toFixed(0) + '%';
        meterRAF = requestAnimationFrame(loop);
      };
      loop();
    } catch (e) { /* 음량 표시 생략 */ }
  }
  function stopMeter() {
    cancelAnimationFrame(meterRAF);
    try { if (meterSrc) meterSrc.disconnect(); } catch (e) { /* 무시 */ }
    meterSrc = null;
  }

  async function testSound() {
    const ctx = getAudioCtx();
    if (!ctx) return;
    E.spkTest.disabled = true;
    E.spkTest.textContent = '재생 중…';
    try {
      const dest = ctx.createMediaStreamDestination();
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.connect(g);
      g.connect(dest);
      const t = ctx.currentTime;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.3, t + 0.03);
      osc.frequency.setValueAtTime(660, t);
      osc.frequency.setValueAtTime(880, t + 0.3);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
      osc.start(t);
      osc.stop(t + 0.75);
      E.testAudio.srcObject = dest.stream;
      const spk = E.spkSel.value;
      if (spk && E.testAudio.setSinkId) await E.testAudio.setSinkId(spk).catch(() => {});
      await E.testAudio.play();
    } catch (e) { /* 재생 실패 */ }
    setTimeout(() => { E.spkTest.disabled = false; E.spkTest.textContent = '테스트 소리'; }, 1000);
  }

  function applySink() {
    const id = E.spkSel.value || LS.get('spkId');
    if (id && E.remoteAudio.setSinkId) E.remoteAudio.setSinkId(id).catch(() => {});
  }

  // ---------- ③ 통화 ----------
  async function enterCall() {
    S.name = E.nameInput.value.trim().slice(0, 30);
    LS.set('name', S.name);
    E.enterBtn.disabled = true;
    const st = await loadIce();
    E.enterBtn.disabled = false;
    if (st === 'unauthorized') {
      clearToken();
      stopMeter();
      stopLocal();
      show('pw');
      pwError('다시 비밀번호를 입력해 주세요.');
      return;
    }
    stopMeter();
    S.leaving = false;
    S.wsRetries = 0;
    S.partner = null;
    S.partnerShare = null;
    S.myShare = null;
    show('call');
    E.roomUrl.textContent = location.host + location.pathname.replace(/index\.html$/, '');
    hideNet();
    applySink();
    updateUI();
    connectWS();
  }

  function connectWS() {
    const u = new URL(API.replace(/^http/, 'ws') + '/ws');
    u.searchParams.set('token', S.token);
    u.searchParams.set('name', S.name || '상대방');
    u.searchParams.set('cid', clientId);
    const ws = new WebSocket(u.toString());
    S.ws = ws;
    let pingTimer = 0;
    ws.onopen = () => {
      S.wsRetries = 0;
      ws.send('ping');
      pingTimer = setInterval(() => { if (ws.readyState === 1) ws.send('ping'); }, 10000);
      hideNet();
    };
    ws.onmessage = (e) => {
      if (e.data === 'pong') return;
      let m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      onServer(m);
    };
    ws.onclose = (e) => {
      clearInterval(pingTimer);
      if (S.ws !== ws) return;
      S.ws = null;
      if (S.leaving || S.screen !== 'call' || e.code === 4001) return;
      if (S.wsRetries >= 6) { showNet('서버에 연결할 수 없어요.'); return; }
      showNet('서버 연결이 끊겼어요. 다시 연결하는 중…');
      const delay = Math.min(8000, 1000 * 2 ** S.wsRetries);
      S.wsRetries += 1;
      setTimeout(() => { if (!S.leaving && S.screen === 'call' && !S.ws) reconnect(); }, delay);
    };
  }

  async function reconnect() {
    const st = await loadIce();
    if (st === 'unauthorized') {
      leaveCall(true);
      clearToken();
      show('pw');
      pwError('다시 비밀번호를 입력해 주세요.');
      return;
    }
    if (!S.leaving && S.screen === 'call' && !S.ws) connectWS();
  }

  function manualReconnect() {
    S.wsRetries = 0;
    const old = S.ws;
    S.ws = null;
    try { if (old) old.close(1000, 'reconnect'); } catch (e) { /* 무시 */ }
    closePC();
    S.partner = null;
    S.partnerShare = null;
    updateUI();
    showNet('다시 연결하는 중…');
    reconnect();
  }

  function sendSignal(data) {
    if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify({ type: 'signal', data }));
  }

  function onServer(m) {
    switch (m.type) {
      case 'welcome':
        closePC();
        if (m.peers && m.peers.length) {
          S.partner = { id: m.peers[0].id, name: m.peers[0].name };
          S.partnerCam = true;
          S.isOfferer = false;
          createPC();
        } else {
          S.partner = null;
        }
        S.partnerShare = null;
        updateUI();
        break;
      case 'peer-joined':
        S.partner = { id: m.id, name: m.name };
        S.partnerCam = true;
        S.partnerShare = null;
        toast(`${partnerName()}님이 입장했어요`);
        startAsOfferer();
        updateUI();
        break;
      case 'peer-left':
        if (S.partner && m.id === S.partner.id) partnerGone();
        break;
      case 'signal':
        if (S.partner && m.from === S.partner.id) {
          S.sigChain = S.sigChain.then(() => handleSignal(m.data)).catch(() => {});
        }
        break;
      case 'full':
        S.leaving = true;
        try { if (S.ws) S.ws.close(); } catch (e) { /* 무시 */ }
        S.ws = null;
        stopShare(false);
        stopLocal();
        show('full');
        break;
      default:
        break;
    }
  }

  function partnerGone() {
    closePC();
    S.partner = null;
    S.partnerShare = null;
    if (S.myShare) stopShare(false);
    toast('상대방이 나갔어요');
    updateUI();
  }

  // ----- WebRTC -----
  function bindRemote() {
    E.remoteAudio.srcObject = S.remote.audio;
    [E.remoteCam, E.remoteCam2, E.panelFaceVideo].forEach((v) => { v.srcObject = S.remote.cam; });
    E.remoteScreen.srcObject = S.remote.screen;
    playAll();
  }

  function createPC() {
    const pc = new RTCPeerConnection({ iceServers: S.iceServers || [] });
    S.pc = pc;
    S.tx = {};
    S.pending = [];
    S.remote = { audio: null, cam: null, screen: null };
    bindRemote();

    pc.onicecandidate = (e) => { if (e.candidate && S.pc === pc) sendSignal({ candidate: e.candidate.toJSON() }); };
    pc.ontrack = (e) => {
      if (S.pc !== pc) return;
      const idx = pc.getTransceivers().indexOf(e.transceiver);
      const key = idx === 0 ? 'audio' : idx === 1 ? 'cam' : idx === 2 ? 'screen' : null;
      if (!key) return;
      S.remote[key] = new MediaStream([e.track]);
      bindRemote();
    };
    pc.onconnectionstatechange = () => onConnState(pc);

    const dc = pc.createDataChannel('ctl', { negotiated: true, id: 0 });
    S.dc = dc;
    dc.onopen = () => { if (S.pc === pc) sendHello(); };
    dc.onmessage = (e) => { if (S.pc !== pc) return; try { onPeer(JSON.parse(e.data)); } catch (err) { /* 무시 */ } };
    return pc;
  }

  function closePC() {
    clearTimeout(S.discTimer);
    if (S.pc) { try { S.pc.close(); } catch (e) { /* 무시 */ } }
    S.pc = null;
    S.dc = null;
    S.tx = {};
    S.pending = [];
    S.remote = { audio: null, cam: null, screen: null };
    bindRemote();
  }

  async function attachSenders() {
    const { tx } = S;
    try {
      if (tx.audio) await tx.audio.sender.replaceTrack(S.localAudio || null);
      if (tx.cam) await tx.cam.sender.replaceTrack(S.localVideo || null);
      if (tx.screen) await tx.screen.sender.replaceTrack(S.screenTrack || null);
    } catch (e) { console.warn('attachSenders', e); }
  }

  async function startAsOfferer() {
    closePC();
    S.isOfferer = true;
    const pc = createPC();
    // 순서 고정: 0 음성, 1 카메라, 2 화면 → 화면 공유를 켜고 끌 때 다시 협상할 필요 없음
    S.tx.audio = pc.addTransceiver('audio', { direction: 'sendrecv' });
    S.tx.cam = pc.addTransceiver('video', { direction: 'sendrecv' });
    S.tx.screen = pc.addTransceiver('video', { direction: 'sendrecv' });
    await attachSenders();
    await makeOffer(false);
  }

  async function makeOffer(restart) {
    const pc = S.pc;
    if (!pc) return;
    try {
      const offer = await pc.createOffer(restart ? { iceRestart: true } : undefined);
      if (S.pc !== pc) return;
      await pc.setLocalDescription(offer);
      sendSignal({ description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
    } catch (e) { console.warn('offer', e); }
  }

  async function handleSignal(d) {
    if (!d) return;
    if (d.restart) { if (S.isOfferer) await makeOffer(true); return; }
    if (!S.pc) createPC();
    const pc = S.pc;
    try {
      if (d.description) {
        const desc = d.description;
        if (desc.type === 'offer') {
          if (S.isOfferer) return;
          await pc.setRemoteDescription(desc);
          if (!S.tx.audio) {
            const t = pc.getTransceivers();
            S.tx = { audio: t[0], cam: t[1], screen: t[2] };
            t.forEach((x) => { try { x.direction = 'sendrecv'; } catch (e) { /* 무시 */ } });
            await attachSenders();
          }
          const ans = await pc.createAnswer();
          await pc.setLocalDescription(ans);
          sendSignal({ description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
        } else if (desc.type === 'answer') {
          if (pc.signalingState === 'have-local-offer') await pc.setRemoteDescription(desc);
        }
        const q = S.pending;
        S.pending = [];
        for (const c of q) await pc.addIceCandidate(c).catch(() => {});
      } else if (d.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(d.candidate).catch(() => {});
        else S.pending.push(d.candidate);
      }
    } catch (e) { console.warn('signal', e); }
  }

  function onConnState(pc) {
    if (S.pc !== pc) return;
    const st = pc.connectionState;
    if (st === 'connected') {
      clearTimeout(S.discTimer);
      hideNet();
      playAll();
    } else if (st === 'disconnected') {
      clearTimeout(S.discTimer);
      S.discTimer = setTimeout(() => {
        if (S.pc === pc && pc.connectionState !== 'connected') {
          showNet('연결이 불안정해요. 다시 연결하는 중…');
          requestRestart();
        }
      }, 2500);
    } else if (st === 'failed') {
      showNet('연결이 끊겼어요. 다시 연결하는 중…');
      requestRestart();
    }
  }

  function requestRestart() {
    if (S.isOfferer) makeOffer(true); else sendSignal({ restart: true });
  }

  // ----- 상대와 직접 주고받는 메시지 (DataChannel) -----
  function sendPeer(obj) {
    if (S.dc && S.dc.readyState === 'open') {
      try { S.dc.send(JSON.stringify(obj)); } catch (e) { /* 무시 */ }
    }
  }

  function sendHello() {
    sendPeer({
      t: 'hello',
      name: S.name,
      cam: camLive(),
      share: S.myShare === 'me' ? 'on' : S.myShare === 'starting' ? 'starting' : 'off',
    });
  }

  function onPeer(m) {
    switch (m.t) {
      case 'hello':
        if (S.partner && m.name) S.partner.name = String(m.name).slice(0, 30);
        S.partnerCam = !!m.cam;
        applyPartnerShare(m.share);
        updateUI();
        break;
      case 'cam':
        S.partnerCam = !!m.on;
        updateUI();
        break;
      case 'share':
        applyPartnerShare(m.s);
        break;
      case 'ptr':
        if (S.myShare === 'me') showPtr(E.panelPtr, E.myScreen, m.x, m.y);
        break;
      case 'ptrup':
        if (S.myShare === 'me') fadePtr(E.panelPtr);
        break;
      case 'tap':
        if (S.myShare === 'me') {
          showPtr(E.panelPtr, E.myScreen, m.x, m.y);
          ripple(E.panelRipples, E.myScreen, m.x, m.y);
          fadePtr(E.panelPtr);
        }
        break;
      default:
        break;
    }
  }

  // ---------- 화면 공유 ----------
  function applyPartnerShare(s) {
    const prev = S.partnerShare;
    if (s === 'starting') {
      S.partnerShare = 'starting';
      if (S.myShare === 'me') toast('상대방이 화면 공유를 준비하고 있어요');
    } else if (s === 'on') {
      S.partnerShare = 'on';
      if (S.myShare) {
        stopShare(false);
        toast('상대방이 화면 공유를 시작해서 내 공유는 자동으로 중지됐어요');
      }
      if (prev !== 'on') waitFirstFrame();
    } else {
      S.partnerShare = null;
      S.pFrame = false;
      if (prev === 'on') toast('상대방이 화면 공유를 끝냈어요');
    }
    updateUI();
  }

  function waitFirstFrame() {
    S.pFrame = false;
    const v = E.remoteScreen;
    let done = false;
    const finish = () => {
      if (done || S.partnerShare !== 'on') return;
      done = true;
      S.pFrame = true;
      updateUI();
    };
    v.play().catch(() => {});
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => finish());
    else v.addEventListener('timeupdate', finish, { once: true });
    setTimeout(finish, 5000);
  }

  async function startShare() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      toast('이 브라우저는 화면 공유를 지원하지 않아요');
      return;
    }
    S.myShare = 'starting';
    sendPeer({ t: 'share', s: 'starting' });
    updateUI();
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'monitor', frameRate: { ideal: 15, max: 30 } },
        audio: false,
        monitorTypeSurfaces: 'include',
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'exclude',
      });
    } catch (e) {
      if (S.myShare === 'starting') {
        S.myShare = null;
        sendPeer({ t: 'share', s: 'off' });
        toast('화면 공유를 취소했어요');
        updateUI();
      }
      return;
    }
    const track = stream.getVideoTracks()[0];
    if (S.myShare !== 'starting') { track.stop(); return; } // 그 사이 취소되었거나 상대가 공유 시작
    const surface = track.getSettings ? track.getSettings().displaySurface : undefined;
    if (surface && surface !== 'monitor') {
      track.stop();
      S.myShare = null;
      sendPeer({ t: 'share', s: 'off' });
      toast('전체 화면을 선택해 주세요. 창이나 탭은 공유할 수 없어요', 4500);
      updateUI();
      return;
    }
    try { track.contentHint = 'detail'; } catch (e) { /* 무시 */ }
    track.onended = () => { if (S.screenTrack === track) stopShare(true); };
    S.screenTrack = track;
    if (S.tx.screen) {
      try { await S.tx.screen.sender.replaceTrack(track); } catch (e) { console.warn('share', e); }
      tuneScreenSender();
    }
    E.myScreen.srcObject = new MediaStream([track]);
    S.myShare = 'me';
    sendPeer({ t: 'share', s: 'on' });
    toast(S.partnerShare === 'on' ? '내 화면 공유를 시작했어요 · 상대방의 공유는 자동으로 중지됐어요' : '전체 화면 공유를 시작했어요');
    S.partnerShare = null;
    updateUI();
    playAll();
    openPip(); // 브라우저가 허락하면 바로 띄우고, 아니면 버튼으로
  }

  function tuneScreenSender() {
    const s = S.tx.screen && S.tx.screen.sender;
    if (!s || !s.getParameters) return;
    try {
      const p = s.getParameters();
      if (!p.encodings || !p.encodings.length) return;
      p.degradationPreference = 'maintain-resolution';
      s.setParameters(p).catch(() => {});
    } catch (e) { /* 무시 */ }
  }

  function stopShare(notify) {
    const was = S.myShare;
    const t = S.screenTrack;
    S.screenTrack = null;
    if (t) { t.onended = null; t.stop(); }
    if (S.tx.screen) S.tx.screen.sender.replaceTrack(null).catch(() => {});
    S.myShare = null;
    E.myScreen.srcObject = null;
    E.panelPtr.classList.remove('on');
    closePip();
    if (notify) {
      sendPeer({ t: 'share', s: 'off' });
      if (was === 'me') toast('화면 공유를 중지했어요');
    }
    updateUI();
  }

  function toggleShare() {
    if (S.myShare === 'starting') {
      S.myShare = null;
      sendPeer({ t: 'share', s: 'off' });
      toast('화면 공유를 취소했어요');
      updateUI();
    } else if (S.myShare === 'me') {
      stopShare(true);
    } else {
      startShare();
    }
  }

  // ---------- 미리보기 창 (항상 위, Chrome/Edge) ----------
  async function openPip() {
    if (!('documentPictureInPicture' in window) || S.pipWin || S.myShare !== 'me') return;
    let win;
    try {
      win = await window.documentPictureInPicture.requestWindow({ width: 380, height: 340 });
    } catch (e) {
      updateUI(); // 버튼으로 다시 시도
      return;
    }
    if (S.myShare !== 'me') { win.close(); return; }
    const link = win.document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('style.css', location.href).href;
    win.document.head.append(link);
    win.document.title = '미리보기';
    win.document.body.className = 'pip-body';
    win.document.body.append(E.panel);
    S.pipWin = win;
    win.addEventListener('pagehide', () => {
      E.panelHome.append(E.panel);
      S.pipWin = null;
      playAll();
      updateUI();
    });
    playAll();
    updateUI();
  }

  function closePip() {
    if (S.pipWin) { try { S.pipWin.close(); } catch (e) { /* 무시 */ } }
  }

  // ---------- 레이저 포인터 ----------
  // 영상이 상자 안에 비율을 유지하며 들어가므로(여백 생김) 실제 영상 영역을 계산
  function contentRect(video) {
    const r = video.getBoundingClientRect();
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh || !r.width || !r.height) return { left: r.left, top: r.top, width: r.width, height: r.height, ox: 0, oy: 0 };
    const s = Math.min(r.width / vw, r.height / vh);
    const w = vw * s;
    const h = vh * s;
    const ox = (r.width - w) / 2;
    const oy = (r.height - h) / 2;
    return { left: r.left + ox, top: r.top + oy, width: w, height: h, ox, oy };
  }

  function normPoint(video, e, clamp) {
    const cr = contentRect(video);
    if (!cr.width || !cr.height) return null;
    let x = (e.clientX - cr.left) / cr.width;
    let y = (e.clientY - cr.top) / cr.height;
    if (!clamp && (x < 0 || x > 1 || y < 0 || y > 1)) return null;
    x = Math.max(0, Math.min(1, x));
    y = Math.max(0, Math.min(1, y));
    return { x, y };
  }

  function showPtr(el, video, x, y) {
    const cr = contentRect(video);
    el.style.left = (cr.ox + x * cr.width) + 'px';
    el.style.top = (cr.oy + y * cr.height) + 'px';
    clearTimeout(el._fade);
    el.classList.add('on');
  }

  function fadePtr(el) {
    clearTimeout(el._fade);
    el._fade = setTimeout(() => el.classList.remove('on'), 1500);
  }

  function ripple(container, video, x, y) {
    const cr = contentRect(video);
    const s = container.ownerDocument.createElement('span');
    s.className = 'ripple';
    s.style.left = (cr.ox + x * cr.width) + 'px';
    s.style.top = (cr.oy + y * cr.height) + 'px';
    container.appendChild(s);
    setTimeout(() => s.remove(), 900);
  }

  function setupViewerPointer() {
    const surf = E.surface;
    const video = E.remoteScreen;
    let down = null;
    let raf = 0;
    let pending = null;

    surf.addEventListener('pointerdown', (e) => {
      if (S.partnerShare !== 'on' || (e.pointerType === 'mouse' && e.button !== 0)) return;
      const p = normPoint(video, e, false);
      if (!p) return;
      down = { x: p.x, y: p.y, cx: e.clientX, cy: e.clientY, moved: false };
      try { surf.setPointerCapture(e.pointerId); } catch (err) { /* 무시 */ }
      e.preventDefault();
    });

    surf.addEventListener('pointermove', (e) => {
      if (!down) return;
      if (!down.moved && Math.hypot(e.clientX - down.cx, e.clientY - down.cy) > 4) down.moved = true;
      if (!down.moved) return;
      const p = normPoint(video, e, true);
      if (!p) return;
      showPtr(E.viewPtr, video, p.x, p.y);
      pending = p;
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (pending) sendPeer({ t: 'ptr', x: round(pending.x), y: round(pending.y) });
          pending = null;
        });
      }
    });

    const up = () => {
      if (!down) return;
      const d = down;
      down = null;
      if (!d.moved) {
        showPtr(E.viewPtr, video, d.x, d.y);
        ripple(E.viewRipples, video, d.x, d.y);
        sendPeer({ t: 'tap', x: round(d.x), y: round(d.y) });
      } else {
        sendPeer({ t: 'ptrup' });
      }
      fadePtr(E.viewPtr);
    };
    surf.addEventListener('pointerup', up);
    surf.addEventListener('pointercancel', up);
  }

  // ---------- 화면 갱신 ----------
  function updateUI() {
    if (S.screen === 'pre') updatePre();
    const mode = S.myShare ? 'me' : S.partnerShare ? 'partner' : 'normal';
    E.stage.dataset.mode = mode;

    const has = !!S.partner;
    const pname = partnerName();
    const pinit = initialOf(pname);
    const pcam = has && S.partnerCam;

    E.waiting.hidden = has;
    E.remoteTag.textContent = pname;
    E.remoteTag2.textContent = pname;
    E.remoteTag.hidden = !has;
    E.remoteInitial.textContent = pinit;
    E.remoteInitial2.textContent = pinit;
    E.panelInitial.textContent = pinit;
    E.remoteCamOff.hidden = !has || pcam;
    E.remoteCamOff2.hidden = pcam;
    E.panelFaceOff.hidden = pcam;

    const myName = S.name ? `${S.name} (나)` : '나';
    E.selfTag.textContent = myName;
    E.selfTag2.textContent = myName;
    E.selfOff.hidden = camLive();
    E.selfOff2.hidden = camLive();

    E.meStarting.hidden = S.myShare !== 'starting';
    E.meLive.hidden = S.myShare !== 'me';
    E.panelHome.hidden = S.myShare !== 'me';
    E.panelFace.hidden = !S.faceShown || !has;
    E.faceToggle.textContent = S.faceShown ? '얼굴 숨기기' : '얼굴 보이기';
    E.panelMic.textContent = S.micOn ? '마이크 켜짐' : '마이크 꺼짐';
    E.panelMic.classList.toggle('off', !S.micOn);
    const pipSupported = 'documentPictureInPicture' in window;
    E.pipOpen.hidden = !pipSupported || !!S.pipWin || S.myShare !== 'me';
    E.pipNote.hidden = !S.pipWin;

    const ready = S.partnerShare === 'on' && S.pFrame;
    E.pStarting.hidden = mode !== 'partner' || ready;
    E.surface.classList.toggle('ready', ready);
    E.ptrHint.hidden = !ready;

    E.micBtn.classList.toggle('off', !S.micOn);
    E.micBtn.setAttribute('aria-label', S.micOn ? '마이크 끄기' : '마이크 켜기');
    E.camBtn.classList.toggle('off', !camLive());
    E.camBtn.setAttribute('aria-label', camLive() ? '카메라 끄기' : '카메라 켜기');
    E.shareBtn.classList.toggle('active', !!S.myShare);
    E.shareBtn.setAttribute('aria-label', S.myShare ? '화면 공유 중지' : '화면 공유');
  }

  // ---------- 나가기 ----------
  function leaveCall(silent) {
    S.leaving = true;
    if (S.myShare) stopShare(true);
    const ws = S.ws;
    S.ws = null;
    try { if (ws) ws.close(1000, 'bye'); } catch (e) { /* 무시 */ }
    closePC();
    S.partner = null;
    S.partnerShare = null;
    stopMeter();
    stopLocal();
    hideNet();
    if (!silent) {
      E.leftTitle.textContent = '통화를 종료했습니다';
      show('left');
    }
  }

  // ---------- 버튼 연결 ----------
  function bindUI() {
    E.hostLabel.textContent = location.host + location.pathname.replace(/index\.html$/, '');
    E.pwForm.addEventListener('submit', submitPw);

    E.camSwitch.addEventListener('click', () => { S.camOn = !S.camOn; LS.set('camOn', S.camOn); applyTrackEnabled(); updatePre(); });
    E.micSwitch.addEventListener('click', () => { S.micOn = !S.micOn; LS.set('micOn', S.micOn); applyTrackEnabled(); updatePre(); });
    E.camSel.addEventListener('change', () => switchDevice('video', E.camSel.value));
    E.micSel.addEventListener('change', () => switchDevice('audio', E.micSel.value));
    E.spkSel.addEventListener('change', () => { LS.set('spkId', E.spkSel.value); applySink(); });
    E.spkTest.addEventListener('click', testSound);
    E.enterBtn.addEventListener('click', enterCall);
    E.nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') enterCall(); });
    E.preCancel.addEventListener('click', () => {
      stopMeter();
      stopLocal();
      E.leftTitle.textContent = '입장을 취소했어요';
      show('left');
    });

    E.micBtn.addEventListener('click', () => { S.micOn = !S.micOn; LS.set('micOn', S.micOn); applyTrackEnabled(); updateUI(); });
    E.panelMic.addEventListener('click', () => E.micBtn.click());
    E.camBtn.addEventListener('click', () => {
      if (!S.localVideo) { toast('카메라를 사용할 수 없어요'); return; }
      S.camOn = !S.camOn;
      LS.set('camOn', S.camOn);
      applyTrackEnabled();
      sendPeer({ t: 'cam', on: camLive() });
      updateUI();
    });
    E.shareBtn.addEventListener('click', toggleShare);
    E.cancelShare.addEventListener('click', toggleShare);
    E.stopShareBig.addEventListener('click', () => stopShare(true));
    E.panelStop.addEventListener('click', () => stopShare(true));
    E.pipOpen.addEventListener('click', openPip);
    E.faceToggle.addEventListener('click', () => { S.faceShown = !S.faceShown; LS.set('faceShown', S.faceShown); updateUI(); });
    E.leaveBtn.addEventListener('click', () => leaveCall(false));
    E.reconnectBtn.addEventListener('click', manualReconnect);
    E.copyLink.addEventListener('click', () => {
      const url = location.origin + location.pathname.replace(/index\.html$/, '');
      if (navigator.clipboard) navigator.clipboard.writeText(url).then(() => toast('주소를 복사했어요'), () => toast(url));
      else toast(url);
    });

    E.rejoinBtn.addEventListener('click', () => { if (S.token) goPrejoin(); else show('pw'); });
    E.retryFullBtn.addEventListener('click', () => goPrejoin());
    E.forgetBtn.addEventListener('click', () => {
      clearToken();
      toast('이 기기에서 비밀번호 기억을 지웠어요');
      show('pw');
    });

    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', () => { if (S.screen === 'pre') fillDevices(); });
    }
    window.addEventListener('pagehide', () => { try { if (S.ws) S.ws.close(1000, 'bye'); } catch (e) { /* 무시 */ } });
    document.addEventListener('click', () => { if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {}); playAll(); }, { capture: true });

    setupViewerPointer();
  }

  // ---------- 시작 ----------
  async function init() {
    if (!API) { show('config'); return; }
    bindUI();
    const tok = LS.get('token') || SS.get('token');
    if (tok && Number(String(tok).split('.')[0]) > Date.now()) {
      S.token = tok;
      const st = await loadIce();
      if (st !== 'unauthorized') { goPrejoin(); return; }
    }
    clearToken();
    show('pw');
    E.pwInput.focus();
  }

  init();
})();
