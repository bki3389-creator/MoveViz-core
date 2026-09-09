# PlanShot AI 데모 프록시 (Cloudflare Worker)

웹 미니BIM의 AI 디자이너 호출을 서버측 키로 대신 처리하는 프록시.
클라이언트에 Anthropic API 키를 노출하지 않고 GitHub Pages(정적 호스팅)에서 AI 데모를 돌릴 수 있다.

- `POST /v1/messages` 만 통과, 그 외 차단
- 서버측 키 주입(`ANTHROPIC_API_KEY` 시크릿), CORS 전면 허용
- KV `RL` 바인딩 시 IP당 하루 30회 제한 (없으면 무제한 — wrangler.toml 주석 참조)
- 요청 2MB 제한, model 화이트리스트(claude-opus-5 / claude-sonnet-5) 강제

## 배포 (5줄)

```sh
cd infra/ai-proxy
npx wrangler login
npx wrangler deploy
npx wrangler secret put ANTHROPIC_API_KEY   # 프롬프트에 키 붙여넣기
# 출력된 URL 확인: https://planshot-ai-proxy.<계정>.workers.dev
```

(선택) 레이트리밋을 켜려면 `npx wrangler kv namespace create RL` 후 wrangler.toml의
`[[kv_namespaces]]` 블록 주석을 해제하고 id를 넣은 뒤 다시 `npx wrangler deploy`.

## 프론트 연결

`apps/web-minibim/js/config.js` 의 `AI_PROXY_URL` 에 워커 URL을 넣는다:

```js
export const AI_PROXY_URL = 'https://planshot-ai-proxy.<계정>.workers.dev';
```

동작 우선순위(js/ai.js): localStorage 개인 키가 있으면 api.anthropic.com 직접 호출,
없고 `AI_PROXY_URL` 이 설정돼 있으면 프록시 경유(키 불필요), 둘 다 없으면 키 설정 안내 오류.

## 이미지 생성 (/v1/images — FLUX Kontext)

니즈 텍스트 + 시점 캡처(구조 유지) → 실사 스타일 이미지. fal.ai 키 필요:

1. https://fal.ai 가입(개인 이메일) → Dashboard → Keys → 키 생성
2. `npx wrangler secret put FAL_KEY` → 키 붙여넣기
3. 한도: IP당 하루 15회(KV RL 바인딩 시). 비용 장당 약 $0.04.
