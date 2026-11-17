# dkmakes call (vcall)

개인용 1:1 화상채팅. 주소: **https://dkmakes.com/vcall/**

- 비밀번호 → 입장 전 확인(이름, 카메라, 마이크, 스피커) → 통화
- 창 또는 Chrome 탭 공유 (전체 화면은 막음). 탭을 공유하면 영상 소리도 전달. 동시에는 한 명, 상대가 시작하면 내 공유는 자동 중지
- 레이저 포인터: 보는 사람이 클릭한 채로 움직이면 공유한 사람의 미리보기 창에 빨간 점, 클릭만 하면 파동
- 공유 중 미리보기 창은 Chrome/Edge에서 다른 앱 위에 떠 있는 작은 창으로 열림

## 구성

| 부분 | 위치 | 하는 일 |
|---|---|---|
| 화면 | 이 저장소 루트 (`index.html`, `app.js`, `style.css`) → GitHub Pages | 앱 화면 |
| 서버 | `worker/` → Cloudflare Workers | 비밀번호 확인, 두 사람 연결 중개, TURN 정보 |

영상, 음성, 화면은 WebRTC로 두 브라우저가 직접(암호화) 주고받습니다.

## 설정

1. `config.js`의 `window.VCALL_API`에 Worker 주소를 넣습니다.
2. Cloudflare Worker 설정 → Variables and Secrets에 **Secret**으로:
   - `ROOM_PASSWORD`: 통화방 비밀번호 (바꾸면 모든 기기에서 다시 입력)
   - `TURN_KEY_ID`, `TURN_KEY_API_TOKEN`: Realtime → TURN 키 (선택, 막힌 네트워크용)
3. 다른 주소에서 쓰려면 `worker/wrangler.toml`의 `ALLOWED_ORIGINS`에 추가합니다.

## 로컬 테스트

```bash
cd worker && echo "ROOM_PASSWORD=test" > .dev.vars && npx wrangler dev
# 다른 터미널: config.js를 http://127.0.0.1:8787 로 바꾸고
python3 -m http.server 5500   # http://localhost:5500
```
