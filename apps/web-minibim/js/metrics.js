// metrics.js — 데이터 플라이휠 지표 (이 기기 localStorage 누적).
// "첫날부터 세고 있다"의 구현체: 실측 로드·AI 제안/적용·고객 링크·견적 발행 카운트.
// 서버 전송 없음 — 개인정보 이슈 없이 수집 메커니즘 자체를 보여주는 스텁.

const LS = 'planshot_metrics';

function load() {
  try { return JSON.parse(localStorage.getItem(LS) || 'null') || {}; } catch { return {}; }
}

export function track(key, n = 1) {
  try {
    const m = load();
    m[key] = (m[key] || 0) + n;
    m._last = new Date().toISOString().slice(0, 10);
    localStorage.setItem(LS, JSON.stringify(m));
  } catch {}
}

export function getMetrics() { return load(); }

/// 사람이 읽는 한 줄 요약 — ⚙ 설정 등에서 표시
export function metricsLine() {
  const m = load();
  const parts = [];
  if (m.scan_load) parts.push(`실측 로드 ${m.scan_load}회`);
  if (m.ai_suggest) parts.push(`AI 제안 ${m.ai_suggest}건${m.ai_apply ? ` · 적용 ${m.ai_apply}건` : ''}`);
  if (m.share) parts.push(`고객 링크 ${m.share}회`);
  const docs = (m.csv || 0) + (m.print || 0) + (m.dxf || 0);
  if (docs) parts.push(`견적·도면 발행 ${docs}회`);
  return parts.length ? `이 기기 누적 — ${parts.join(' · ')}` : '이 기기 누적 — 아직 기록 없음';
}
