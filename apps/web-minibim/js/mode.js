// mode.js — 양면 모드 상태 (home=내 집 | pro=프로): URL ?mode > localStorage > 선택 오버레이.
// body 클래스(mode-home/mode-pro)가 단일 진실 — 숨김·순서·라벨 전환은 전부 CSS(pro-only/home-only).
import { emit } from './state.js';

const LS = 'planshot_mode';
let _mode = 'home';        // 잠정 기본값 (오버레이 배경 렌더용)
let _decided = false;      // 사용자가 실제로 고른 적 있는가

export const getMode = () => _mode;

export function setMode(m, { persist = true, silent = false } = {}) {
  _mode = (m === 'pro') ? 'pro' : 'home';
  document.body.classList.toggle('mode-home', _mode === 'home');
  document.body.classList.toggle('mode-pro', _mode === 'pro');
  if (persist) { _decided = true; try { localStorage.setItem(LS, _mode); } catch {} }
  const chip = document.getElementById('modeSwitch');
  if (chip) chip.textContent = _mode === 'home' ? '🏠 내 집 모드' : '🔧 프로 모드';
  if (!silent) emit('mode');   // main.js 렌더 훅이 견적 요약 스왑까지 다시 그림
}

/// 부팅 시 1회. true = 오버레이 없이 결정됨.
export function initMode() {
  const q = new URLSearchParams(location.search).get('mode');
  if (q === 'home' || q === 'pro') { setMode(q, { silent: true }); return true; }
  let ls = null; try { ls = localStorage.getItem(LS); } catch {}
  if (ls === 'home' || ls === 'pro') { _decided = true; setMode(ls, { persist: false, silent: true }); return true; }
  setMode('home', { persist: false, silent: true });   // 잠정 — 저장 안 함
  return false;
}

// ── 선택 오버레이 ─────────────────────────────────
export function openModeOverlay(closable) {
  const ov = document.getElementById('modeOverlay');
  ov.hidden = false;
  ov.dataset.closable = closable ? '1' : '';   // 첫 방문(강제 선택)엔 Esc/배경클릭 닫기 금지
}
export function closeModeOverlay() { document.getElementById('modeOverlay').hidden = true; }
export const overlayOpen = () => !document.getElementById('modeOverlay').hidden;
export const overlayClosable = () => document.getElementById('modeOverlay').dataset.closable === '1';

export function wireModeOverlay(onPick) {
  const ov = document.getElementById('modeOverlay');
  ov.querySelectorAll('.mo-card').forEach(c => {
    c.onclick = () => { setMode(c.dataset.mode); closeModeOverlay(); onPick?.(c.dataset.mode); };
  });
  ov.addEventListener('click', e => { if (e.target === ov && overlayClosable()) closeModeOverlay(); });
}

// ── 쉬운말 사전 (home 표시 전용 — catalog 데이터·CSV·DXF·프로젝트 JSON은 원문 유지) ──
// 긴 어구가 먼저 오도록 정렬(부분치환 오염 방지).
const EZ = [
  ['경량 가벽 신설', '새 벽 만들기(경량)'],
  ['목공 가벽 신설', '새 벽 만들기(목공)'],
  ['무몰딩 마감', '몰딩 없는 민마감'],
  ['천장 몰딩', '천장 테두리 마감'],
  ['벽 순면적', '실제 벽 면적'],
  ['걸레받이', '바닥 테두리 마감'],
  ['벽 철거', '벽 없애기'],
  ['재료단가', '자재값'],
  ['노무단가', '인건비'],
  ['재료비', '자재비'],
  ['노무비', '인건비'],
  ['부가세', '세금(부가세)'],
  ['소계', '공사비 합계'],
  ['총계', '총 예상 비용'],
  ['가벽', '새 벽'],
];
export const ez = s => (typeof document !== 'undefined' && document.body.classList.contains('mode-home'))
  ? EZ.reduce((t, [a, b]) => t.replaceAll(a, b), String(s ?? '')) : String(s ?? '');

/// 렌더된 DOM 서브트리의 텍스트 노드만 일괄 치환 — 이벤트/입력값 무손상 (home 전용)
export function ezApply(root) {
  if (!root || !document.body.classList.contains('mode-home')) return;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n; (n = w.nextNode()); ) {
    const v = ez(n.nodeValue);
    if (v !== n.nodeValue) n.nodeValue = v;
  }
}
