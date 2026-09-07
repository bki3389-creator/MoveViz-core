// worker.js — PlanShot AI 데모 프록시 (Cloudflare Worker)
//
// 웹 미니BIM(js/ai.js)의 Claude API 호출을 대신 받아 서버측 키(env.ANTHROPIC_API_KEY)를
// 주입한 뒤 api.anthropic.com/v1/messages 로 전달한다. 클라이언트는 키 없이 호출한다.
//
// 동작 요약:
//  - POST /v1/messages 만 통과 (그 외 경로 404 / 그 외 메서드 405)
//  - CORS: 모든 오리진 허용 + OPTIONS preflight 처리, 필요한 헤더 노출
//  - 레이트리밋: env.RL(KV) 바인딩이 있으면 IP당 하루 30회 (키: rl:<ip>:<yyyymmdd>),
//    KV가 없으면(데모/로컬) 제한 없이 통과
//  - 요청 본문 2MB 제한 (시점 캡처 JPEG base64 포함해도 충분)
//  - model 화이트리스트 강제: claude-opus-5 / claude-sonnet-5 외의 값은 claude-opus-5로 교체
//  - 스트리밍 미지원: body의 stream 플래그를 제거하고 업스트림 JSON을 그대로 반환
//  - 모든 자체 오류는 {"error":{"message":"..."}} JSON (프론트의 `API ${status}` 표시와 호환)

const UPSTREAM = 'https://api.anthropic.com/v1/messages';
const MODEL_WHITELIST = ['claude-opus-5', 'claude-sonnet-5'];
const DEFAULT_MODEL = 'claude-opus-5';
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2MB
const DAILY_LIMIT = 30;                 // IP당 하루 허용 횟수 (KV 있을 때만)

// CORS 공통 헤더 — 데모 프록시이므로 모든 오리진 허용 (자격증명 없는 요청이라 '*' 가능)
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  // 프론트가 보내는 헤더 전부 허용 (x-api-key는 프록시 경유 시 생략되지만, 보내와도 무시하고 통과시킴)
  'Access-Control-Allow-Headers':
    'content-type, x-api-key, anthropic-version, anthropic-beta, anthropic-dangerous-direct-browser-access',
  // 디버깅에 유용한 응답 헤더를 브라우저 JS에 노출
  'Access-Control-Expose-Headers': 'request-id, retry-after',
  'Access-Control-Max-Age': '86400',
};

// {error:{message}} 형태의 JSON 오류 응답 (CORS 헤더 포함)
function errorResponse(status, message) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

// UTC 기준 yyyymmdd — 레이트리밋 키의 날짜 파트
function todayKey() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── CORS preflight ──────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // ── 라우팅: POST /v1/messages 만 허용 ───────────
    if (url.pathname !== '/v1/messages') {
      return errorResponse(404, '지원하지 않는 경로입니다 — POST /v1/messages 만 사용할 수 있습니다');
    }
    if (request.method !== 'POST') {
      return errorResponse(405, 'POST만 허용됩니다');
    }

    // ── 서버측 키 확인 ──────────────────────────────
    if (!env.ANTHROPIC_API_KEY) {
      return errorResponse(500, '프록시에 ANTHROPIC_API_KEY 시크릿이 설정되지 않았습니다 (wrangler secret put ANTHROPIC_API_KEY)');
    }

    // ── 레이트리밋 (KV 바인딩 RL이 있을 때만) ───────
    // KV는 최종 일관성이라 정확한 카운터는 아니지만 데모 남용 방지 용도로는 충분.
    if (env.RL) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const key = `rl:${ip}:${todayKey()}`;
      try {
        const count = parseInt((await env.RL.get(key)) || '0', 10);
        if (count >= DAILY_LIMIT) {
          return errorResponse(429, `오늘의 무료 사용량(${DAILY_LIMIT}회)을 모두 사용했습니다 — 내일 다시 시도하거나 개인 API 키를 설정해 주세요`);
        }
        // 이틀 뒤 자동 만료 (당일 키만 유효하므로 넉넉히)
        await env.RL.put(key, String(count + 1), { expirationTtl: 172800 });
      } catch {
        // KV 장애 시 데모가 멈추지 않도록 통과시킨다
      }
    }

    // ── 요청 크기 제한 + 본문 파싱 ──────────────────
    let raw;
    try {
      raw = await request.arrayBuffer();
    } catch {
      return errorResponse(400, '요청 본문을 읽을 수 없습니다');
    }
    if (raw.byteLength > MAX_BODY_BYTES) {
      return errorResponse(413, '요청이 너무 큽니다 (최대 2MB) — 캡처 이미지 품질을 낮춰 주세요');
    }
    let body;
    try {
      body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return errorResponse(400, '본문이 올바른 JSON이 아닙니다');
    }

    // ── model 화이트리스트 강제 교체 ────────────────
    // 클라이언트가 어떤 모델을 요청하든 허용 목록 밖이면 기본 모델로 바꾼다 (비용 통제).
    if (!MODEL_WHITELIST.includes(body.model)) body.model = DEFAULT_MODEL;

    // ── 스트리밍 미지원 — 항상 단건 JSON 응답 ───────
    delete body.stream;

    // ── 업스트림 전달 헤더 구성 ─────────────────────
    // x-api-key 는 항상 서버측 키로 교체(클라이언트가 보냈어도 무시).
    // anthropic-dangerous-direct-browser-access 는 서버→서버 호출이므로 불필요, 전달하지 않음.
    const upstreamHeaders = {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': request.headers.get('anthropic-version') || '2023-06-01',
    };
    // 베타 헤더(server-side-fallback-2026-07-01 등)는 그대로 전달 — body의 fallbacks:'default'와 짝
    const beta = request.headers.get('anthropic-beta');
    if (beta) upstreamHeaders['anthropic-beta'] = beta;

    // ── 업스트림 호출 → JSON 그대로 반환 ────────────
    let upstream;
    try {
      upstream = await fetch(UPSTREAM, {
        method: 'POST',
        headers: upstreamHeaders,
        body: JSON.stringify(body),
      });
    } catch (e) {
      return errorResponse(502, '업스트림(api.anthropic.com) 호출 실패: ' + (e && e.message ? e.message : e));
    }

    // 업스트림 상태/본문을 그대로 전달하되 CORS 헤더를 덧붙인다.
    // (오류 시 Anthropic이 이미 {error:{...}} JSON을 주므로 프론트 처리 방식과 호환)
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') || 'application/json',
        'request-id': upstream.headers.get('request-id') || '',
        ...CORS_HEADERS,
      },
    });
  },
};
