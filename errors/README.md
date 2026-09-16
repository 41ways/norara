# norara 오류·지표 수집

게임 화면에서 터진 오류와 판 수·인원·걸린 시간을 한곳에 모은다. Cloudflare Workers 무료 플랜 + D1.

## 지표 (POST /ev)

게임 코드에서 `norara.ev("start", { n: 사람수 })` · `norara.ev("end", { n: 사람수, sec: 걸린초 })` 로 부른다.
날짜·게임·이름으로 묶어 더하기만 하므로 한 판에 한 줄씩 쌓이지 않는다.

- 온라인 게임은 **방장 화면에서만** 보낸다. 사람마다 보내면 한 판이 인원수만큼 세어진다
- `visit` 은 화면이 자동으로 보낸다 (탭을 덮거나 닫을 때 한 번, 5초 미만은 뺀다)
- **localhost 에서 온 지표는 버린다** — 만들면서 돌린 판이 섞이지 않게. 오류는 localhost 것도 받는다

## 오류 (POST /report)

화면 조각은 각 게임 `index.html` 맨 아래에 있다 (`window.onerror` · 처리되지 않은 Promise 거절 → `sendBeacon`).

- 같은 오류(앱·메시지·파일·줄)는 한 줄에 쌓아 세기만 한다. 줄이 4000개를 넘으면 오래된 것부터 지운다
- 확장 프로그램에서 난 오류와 내용 없는 `Script error.` 는 버린다
- 한 화면이 한 번 열릴 때 다섯 건까지, 한 주소에서 1분에 스무 건까지

## 보기

    https://norara-errors.41ways.workers.dev/?key=열쇠        # 오류 표
    https://norara-errors.41ways.workers.dev/stats?key=열쇠   # 지표 표
    https://norara-errors.41ways.workers.dev/list?key=열쇠    # 오류 JSON
    https://norara-errors.41ways.workers.dev/nums?key=열쇠    # 지표 JSON (days= 로 기간)

열쇠는 워커 비밀값 `VIEW_KEY`. 바꾸려면:

    printf '%s' 새열쇠 | npx wrangler secret put VIEW_KEY

## 손보기

    npx wrangler deploy                                     # 고치면 반드시
    npx wrangler d1 execute norara-errors --remote --file=schema.sql
    npx wrangler d1 execute norara-errors --remote --command "DELETE FROM errs"
    npx wrangler d1 execute norara-errors --remote --command "DELETE FROM evs"
