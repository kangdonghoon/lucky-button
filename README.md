# The Luckiest Person in the World 🍀

(세상에서 제일 운이 좋은 사람) 게임 화면·관리자 페이지·서버 응답 메시지는 영어예요. 이 README와 서버 로그는 한국어예요.


두 버튼 중 하나는 **통과**, 하나는 **실패**. 정답은 누를 때마다 무작위로 바뀌고, 가장 멀리 간 단계가 **실시간 리더보드**에 올라가요.
링크만 있으면 누구나 가입하고 바로 할 수 있어요.

## 규칙
- 버튼 A·B 중 하나를 누르면 결과가 공개돼요 (PC는 ←/→ 또는 A/D 키, 다시 도전은 Space).
- 통과하면 다음 단계로, 실패하면 게임 끝. n단계에 도달할 확률은 1/2ⁿ.
- **정답은 서버가 누를 때마다 새로 정해요** (`crypto.randomInt`). 브라우저는 결과만 받아서 보여 줘요. 그래서 개발자 도구로 정답을 미리 보거나 점수를 조작할 수 없어요.
- 최고 기록은 그 단계에 **통과하는 순간** 저장돼요. 중간에 창을 닫아도 기록은 남고, 새로고침하면 진행 중이던 단계에서 이어서 해요.
- 리더보드는 상위 20명. 같은 단계면 먼저 달성한 사람이 위예요.
- 3단계 이상 가고 있는 사람은 "🔥 지금 도전 중"에 실시간으로 보여요.
- 연타·자동 클릭을 막으려고 버튼은 서버 기준 0.25초에 한 번만 받아요.

## 구조 (프레임워크 없음)
| 파일 | 역할 |
|---|---|
| `server.js` | Node `http` 서버 하나. 정적 파일, `POST /api`, `GET /events`(SSE 리더보드), `GET /api/board`, `/healthz` |
| `store.js` | `DATABASE_URL`이 있으면 Postgres(`PgStore`), 없으면 메모리(`MemStore`). 테이블은 시작할 때 자동 생성 |
| `public/index.html`, `app.js`, `style.css` | 게임·로그인·리더보드 화면. 효과음은 WebAudio 합성 |
| `public/admin.html` | 관리자 페이지 (`/admin`) |
| `test/` | 저장소 테스트, 서버 통합 테스트, 로컬 Postgres용 `pg-shim.js` |

- 계정: 아이디·비밀번호·닉네임. 비밀번호는 scrypt 해시, 세션 토큰은 sha256만 DB에 저장(30일).
- 진행 중인 도전은 서버 메모리에만 있어요. 서버가 잠들면 진행 중이던 도전은 사라지지만, 최고 기록은 DB에 남아요.
- API (`POST /api`, 본문 `{t, sess, ...}`): `signup`, `login`, `logout`, `me`, `nick`, `start`, `pick {i: 0|1}`, 관리자용 `adminUsers`, `adminBan`, `adminResetBest`, `adminNick`.

## 관리자
`ADMIN_USERS` 환경 변수에 쉼표로 아이디를 적어요(예: `donghun`). 그 아이디로 먼저 게임에서 가입해야 해요.
`/admin`에서 회원 검색, 닉네임 변경, 기록 초기화, 이용 정지(로그인 해제 + 리더보드에서 숨김)를 할 수 있어요.

## 로컬 실행
```bash
npm install
npm start            # http://localhost:3000 (DATABASE_URL 없으면 메모리 저장)
npm test
```
로컬 Postgres로 테스트: `PSQL_ARGS="-h /tmp -p 5433 -U postgres -d lucky_test" node test/store.test.js`

## 배포 (Render + Neon, 무료)
1. **Neon**에서 프로젝트를 만들고 연결 문자열(`postgresql://...`)을 복사해요.
2. **Render** → New → Web Service → 이 저장소 선택.
   - **Language: Node**, **Instance: Free**, **Region: Singapore**
   - Build `npm install`, Start `node server.js`, Health check path `/healthz`
3. 환경 변수
   - `DATABASE_URL` = Neon 연결 문자열
   - `ADMIN_USERS` = 관리자 아이디 (`ADMIN_USER` 아님)
4. 이후 main에 push하면 자동으로 다시 배포돼요.

무료 한도: Render는 15분 동안 요청이 없으면 잠들고, 깨는 데 1분쯤 걸려요(화면에 "서버를 깨우는 중" 표시). Neon은 5분 쉬면 멈췄다가 요청이 오면 다시 켜져요.
