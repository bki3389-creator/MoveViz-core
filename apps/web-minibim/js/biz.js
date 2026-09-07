// biz.js — 프로 사업자 프로필·내 단가표·이윤율 (전역 localStorage — 프로젝트와 분리).
// 프로젝트 단가(project.rates)는 현장별 조정, myRates는 모든 현장의 기본값.
// 우선순위: project.rates > myRates > catalog 기본단가.

const LS = 'planshot_biz';
let _biz = null;

export function getBiz() {
  if (_biz) return _biz;
  try { _biz = JSON.parse(localStorage.getItem(LS) || 'null') || {}; } catch { _biz = {}; }
  if (!_biz.myRates) _biz.myRates = {};
  return _biz;
}

export function saveBiz(patch) {
  const b = { ...getBiz(), ...patch };
  _biz = b;
  try { localStorage.setItem(LS, JSON.stringify(b)); } catch {}
  return b;
}

export function setMyRate(id, m, l) {
  const b = getBiz();
  b.myRates[id] = { m, l };
  saveBiz({ myRates: b.myRates });
}

/// 테스트용 — 캐시 무효화
export function _resetBizCache() { _biz = null; }
