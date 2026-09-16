# norara 오류 수집

게임 화면에서 터진 오류를 한곳에 모은다. Cloudflare Workers 무료 플랜 + D1.

- 화면 조각은 각 게임 `index.html` 맨 아래에 있다 (`window.onerror` · 처리되지 않은 Promise 거절 → `sendBeacon`)
- 같은 오류(앱·메시지·파일·줄)는 한 줄에 쌓아 세기만 한다. 줄이 4000개를 넘으면 오래된 것부터 지운다
- 확장 프로그램에서 난 오류와 내용 없는 `Script error.` 는 버린다
- 한 화면이 한 번 열릴 때 다섯 건까지, 한 주소에서 1분에 스무 건까지

## 보기

    https://norara-errors.41ways.workers.dev/?key=열쇠        # 표
    https://norara-errors.41ways.workers.dev/list?key=열쇠    # JSON
    https://norara-errors.41ways.workers.dev/list?key=열쇠&app=robo77

열쇠는 워커 비밀값 `VIEW_KEY`. 바꾸려면:

    printf '%s' 새열쇠 | npx wrangler secret put VIEW_KEY

## 손보기

    npx wrangler deploy                                     # 고치면 반드시
    npx wrangler d1 execute norara-errors --remote --file=schema.sql
    npx wrangler d1 execute norara-errors --remote --command "DELETE FROM errs"
