import { state, on, emit, selectedRoom, metricsOf, pushProjectHistory, undo } from './state.js';
import { getBiz } from './biz.js';
import { item, KRW, canonId } from './catalog.js';
import { setScenePresentation, setWallCutaway, frameRoom, frameAll, captureProposalRoom, exitWalk, isWalking } from './scene3d.js';
import { studioTemplate, designTemplate, sceneTemplate } from './studio-template.js';
import { FINISH_GROUPS, changeStudioFinish, applyStudioStyle, buildStudioReview } from './studio-model.js';
import { track } from './metrics.js';
import * as aiMod from './ai.js';

const $ = id => document.getElementById(id);
const money = value => KRW(Math.round(value)) + '원';
const difference = value => value === 0 ? '변동 없음' : (value > 0 ? '+' : '−') + money(Math.abs(value));
const hex = c => '#' + Number(c ?? 0xeeeeee).toString(16).padStart(6, '0');

export function initStudio({ setTab, openProposal, notify }) {
  $('topbar').insertAdjacentHTML('beforebegin', studioTemplate());
  $('right').insertAdjacentHTML('afterbegin', designTemplate());
  $('center').insertAdjacentHTML('afterbegin', sceneTemplate());
  $('center').insertAdjacentHTML('beforeend', `<section id="studioComparison" class="studio-comparison" hidden aria-label="실제 공간 변경 전후 비교">
    <div class="studio-comparison-head"><b>같은 공간, 달라진 마감</b><button id="studioCompareClose" type="button">비교 닫기</button></div>
    <div class="studio-comparison-images" style="--split:50%"><img id="studioAfterImage" alt="현재 마감을 적용한 실제 공간"><img id="studioBeforeImage" alt="변경 전 마감의 같은 공간"><span class="studio-before-label">변경 전</span><span class="studio-after-label">현재 계획</span><div class="studio-comparison-divider"></div></div>
    <label class="studio-comparison-range">좌우로 움직여 비교<input id="studioCompareRange" type="range" min="0" max="100" value="50" aria-label="변경 전후 비교 위치"></label>
    <p>실측 모델의 마감 비교입니다. 구조·가구·수량은 현재 계획과 같습니다.</p>
  </section>`);
  $('secEst').insertAdjacentHTML('afterbegin', `<div id="studioCostIntro"><span class="studio-eyebrow">03 / COST REVIEW</span><h2>공사 범위와 비용을<br>함께 확인하세요.</h2><p id="studioCostContext"></p><strong id="studioCostTotal"></strong><div id="studioCostBreakdown"></div></div>`);
  $('studioCostIntro').insertAdjacentHTML('afterend', `<div id="studioCostActions"><button id="studioCostProposal" class="studio-primary">이 계획으로 제안서 보기 <span>↗</span></button><button id="studioCostCSV" class="studio-secondary">견적 CSV</button><button id="studioCostPrint" class="studio-secondary">상세 견적 인쇄</button><button id="studioCostBiz" class="studio-secondary">내 단가·이윤 설정</button></div>`);
  $('right').insertAdjacentHTML('afterbegin', `<section id="studioSpaceReview" class="studio-space-review"><span class="studio-overline">01 / SPACE REVIEW</span><h1>변화는 내 공간에서.</h1><p>실측한 구조와 가구 배치를 먼저 확인하세요.</p><h2 id="studioSpaceName"></h2><dl id="studioSpaceMetrics"></dl><div class="studio-space-note">마감을 바꿔도 실측한 구조는 그대로 유지됩니다. 방의 형태와 배치를 수정하려면 도면과 상세 편집을 이용하세요.</div><button id="studioSpaceDesign" class="studio-primary">이 공간 디자인하기 <span>→</span></button><button id="studioSpaceDetails" class="studio-secondary">구조·가구 상세 편집</button></section>`);
  $('left').insertAdjacentHTML('afterbegin', '<div id="studioSpaceIntro"><span class="studio-eyebrow">PROJECT ROOMS</span><h2>내 공간</h2><p>공간을 선택하고 마감을 바꿔보세요.</p><button id="studioStartDesign" class="studio-primary">선택한 공간 디자인 <span>→</span></button></div>');

  let active = false, step = 'space', lastRoom = null;
  let refreshFrame = 0;
  function focusScene() {
    if (!active || document.body.classList.contains('proposal-open')) return;
    cancelAnimationFrame(refreshFrame);
    refreshFrame = requestAnimationFrame(() => {
      if (step === 'design' && selectedRoom()) frameRoom(selectedRoom().id);
      else frameAll();
    });
  }
  function closeComparison() { $('studioComparison').hidden = true; }
  function go(next) {
    if (!['space', 'design', 'cost'].includes(next)) return;
    if (isWalking()) exitWalk();
    step = next;
    document.body.dataset.studioStep = step;
    document.body.classList.remove('studio-tools-open');
    $('studioTools').setAttribute('aria-expanded', 'false');
    closeComparison();
    state.mode = 'select'; state.pendingLine = null;
    setTab('3d');
    render(); focusScene();
  }
  function open(next = step) {
    active = true;
    document.body.classList.add('studio-active');
    setScenePresentation(true);
    const r = selectedRoom();
    if (r && !state.selRoom) { state.selRoom = r.id; state.sel = { kind: 'room', roomId: r.id }; emit('select'); }
    go(['space', 'design', 'cost'].includes(next) ? next : 'space');
  }
  function apply(nextProject) {
    if (state.customerView) return;
    pushProjectHistory(); state.project = nextProject;
    closeComparison(); emit('project');
    $('studioStatus').textContent = '변경 반영됨 · 이 브라우저에 자동 저장';
  }
  function render() {
    const p = state.project, r = selectedRoom();
    const review = buildStudioReview(p, r?.id, getBiz(), state.customerView);
    if (document.activeElement !== $('studioProjectName')) $('studioProjectName').value = p?.name || '';
    $('studioProjectName').readOnly = state.customerView;
    $('studioStatus').textContent = state.customerView ? '고객 열람용 · 읽기 전용' : p?.proposalDemo ? '샘플 프로젝트 · 실측 파일을 열어 시작하세요' : '이 브라우저에 자동 저장';
    const area = (p?.rooms || []).reduce((sum, room) => sum + metricsOf(room).area, 0);
    document.body.classList.toggle('studio-object-selected', !!state.sel && state.sel.kind !== 'room');
    $('studioSpaceName').textContent = r?.name || '실측 파일로 시작하세요';
    const roomMetrics = r && metricsOf(r);
    const metrics = $('studioSpaceMetrics'); metrics.replaceChildren();
    if (r) for (const [label, value] of [['바닥 면적', `${roomMetrics.area.toFixed(1)}㎡`], ['벽 마감 면적', `${roomMetrics.wallNet.toFixed(1)}㎡`], ['가구', `${r.plan?.furniture?.length || r.furniture?.length || 0}개`], ['조명', `${r.lights?.length || 0}개`]]) {
      const dt = document.createElement('dt'); dt.textContent = label;
      const dd = document.createElement('dd'); dd.textContent = value; metrics.append(dt, dd);
    }
    $('studioSpaceDesign').disabled = !r; $('studioSpaceDetails').hidden = state.customerView;
    $('studioRoomName').textContent = r?.name || '공간을 추가하세요';
    $('studioRoomArea').textContent = r ? `${metricsOf(r).area.toFixed(1)}㎡ · 선택한 공간에만 적용` : '실측 파일이나 샘플로 시작할 수 있습니다.';
    $('studioSceneTitle').textContent = step === 'design' ? r?.name || '내 공간' : p?.name || '내 공간';
    $('studioSceneMeta').textContent = step === 'design' && r ? `${metricsOf(r).area.toFixed(1)}㎡ · 실측 모델` : `${p?.rooms?.length || 0}개 공간 · ${area.toFixed(1)}㎡`;
    $('studioSceneHint').textContent = state.activeTab === '2d' ? '드래그로 배치 조정 · 휠로 확대' : '드래그로 회전 · 두 손가락 또는 휠로 확대';
    $('studioTotal').textContent = money(review.current.total);
    $('studioDelta').textContent = `선택 공간 변경 전 대비 ${difference(review.delta)} · 전체 공사비 / VAT 포함`;
    $('studioCostTotal').textContent = money(review.current.total);
    $('studioCostContext').textContent = `${p?.rooms?.length || 0}개 공간 · ${area.toFixed(1)}㎡ · VAT 포함 예상 공사비`;
    const breakdown = $('studioCostBreakdown'); breakdown.replaceChildren();
    for (const room of p?.rooms || []) {
      const row = document.createElement('div');
      const label = document.createElement('span'); label.textContent = room.name;
      const value = document.createElement('b'); value.textContent = money(review.current.rows.filter(x => x.roomId === room.id).reduce((sum, x) => sum + x.amount, 0));
      row.append(label, value); breakdown.append(row);
    }
    const common = review.current.rows.filter(x => !x.roomId).reduce((sum, x) => sum + x.amount, 0);
    if (common) {
      const row = document.createElement('div'); row.innerHTML = '<span>공통 비용·제경비</span><b></b>';
      row.lastElementChild.textContent = money(common); breakdown.append(row);
    }
    const tax = document.createElement('div'); tax.innerHTML = '<span>부가세</span><b></b>'; tax.lastElementChild.textContent = money(review.current.vat); breakdown.append(tax);
    document.querySelectorAll('button[data-studio-step]').forEach(button => {
      const selected = button.dataset.studioStep === step;
      button.classList.toggle('is-active', selected);
      if (selected) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current');
    });
    document.querySelectorAll('[data-studio-style]').forEach(button => {
      button.disabled = state.customerView || !r || (button.dataset.studioStyle !== 'current' && /욕실|화장실|발코니|베란다/.test(r.name));
      const matchesApplied = r && p?.proposal?.roomId === r.id && FINISH_GROUPS.every(g =>
        p.proposal.applied?.[g.field] === r[g.field] && (p.proposal.applied?.finishColors?.[g.kind] ?? null) === (r.finishColors?.[g.kind] ?? null));
      const chosen = button.dataset.studioStyle === 'current' ? review.changes.length === 0 : matchesApplied && p.proposal.selectedStyle === button.dataset.studioStyle;
      button.setAttribute('aria-pressed', String(chosen));
    });
    $('studioStartDesign').disabled = !r;
    $('studioNext').disabled = !r;
    $('studioCompare').disabled = !r;
    $('studioUndo').disabled = state.customerView;
    $('studioCostBiz').hidden = state.customerView;
    $('studioImport').hidden = state.customerView; $('studioSave').hidden = state.customerView;
    const changes = $('studioChangeList'); changes.replaceChildren();
    for (const change of review.changes) {
      const el = document.createElement('div'); el.className = 'studio-change';
      const description = document.createElement('span'); description.textContent = `${change.label} · ${change.before} → ${change.after}${change.colorOnly ? ' 색상 변경' : ''}`;
      const amount = document.createElement('b'); amount.textContent = difference(change.delta);
      el.append(description, amount); changes.append(el);
    }
    if (!review.changes.length) changes.textContent = '마감을 선택하면 변경 내역과 비용 차이가 여기에 표시됩니다.';
    const fields = $('studioFinishes'); fields.replaceChildren();
    if (r) for (const group of FINISH_GROUPS) {
      const wrap = document.createElement('div'); wrap.className = 'studio-finish';
      const label = document.createElement('label'); label.htmlFor = `studioFinish-${group.kind}`; label.textContent = group.label;
      const select = document.createElement('select'); select.id = label.htmlFor; select.disabled = state.customerView;
      for (const material of group.items) {
        const option = document.createElement('option'); option.value = material.id; option.textContent = material.name;
        option.selected = material.id === canonId(r[group.field]); select.append(option);
      }
      select.onchange = () => apply(changeStudioFinish(state.project, r.id, group.kind, select.value));
      const color = document.createElement('input'); color.type = 'color'; color.id = `studioColor-${group.kind}`;
      color.value = hex(r.finishColors?.[group.kind] ?? item(canonId(r[group.field]))?.color); color.disabled = state.customerView;
      color.setAttribute('aria-label', group.label + ' 표시 색상');
      color.onchange = () => apply(changeStudioFinish(state.project, r.id, group.kind, canonId(r[group.field]), parseInt(color.value.slice(1), 16)));
      const meta = document.createElement('span'); meta.className = 'studio-finish-meta';
      const material = item(canonId(r[group.field]));
      meta.textContent = `${material?.spec || ''} · ${money(review.current.rows.filter(x => x.roomId === r.id && x.cat === group.label).reduce((sum, x) => sum + x.amount, 0))}${group.kind === 'wall' && Object.keys(r.wallOverrides || {}).length ? ' · 개별 벽 지정 유지' : ''}`;
      wrap.append(label, select, color, meta); fields.append(wrap);
    }
  }
  document.querySelectorAll('button[data-studio-step]').forEach(button => { button.onclick = () => go(button.dataset.studioStep); });
  $('studioStartDesign').onclick = () => go('design');
  $('studioSpaceDesign').onclick = () => go('design');
  $('studioSpaceDetails').onclick = () => { document.body.classList.add('studio-tools-open'); $('studioTools').setAttribute('aria-expanded', 'true'); setTab('2d'); };
  $('studioNext').onclick = () => go('cost');
  $('studioProposal').onclick = $('studioCostProposal').onclick = () => { closeComparison(); openProposal(); };
  $('studioImport').onclick = () => $('btnOpen').click();
  $('studioSave').onclick = () => $('btnSave').click();
  $('studioCostCSV').onclick = () => $('btnCSV').click();
  $('studioCostPrint').onclick = () => $('btnPrint').click();
  $('studioCostBiz').onclick = () => $('btnBiz').click();
  $('studioProjectName').onchange = e => {
    if (state.customerView) return;
    state.project.name = e.target.value; $('projName').value = e.target.value; emit('meta');
  };
  $('studioTools').onclick = () => {
    const expanded = document.body.classList.toggle('studio-tools-open');
    $('studioTools').setAttribute('aria-expanded', String(expanded));
  };
  $('studioView2d').onclick = () => { closeComparison(); setTab('2d'); };
  $('studioView3d').onclick = () => { closeComparison(); setTab('3d'); focusScene(); };
  $('studioFrame').onclick = focusScene;
  $('studioWallToggle').onclick = () => {
    closeComparison();
    if (isWalking()) exitWalk();
    const opened = setWallCutaway($('studioWallToggle').getAttribute('aria-pressed') !== 'true');
    $('studioWallToggle').setAttribute('aria-pressed', String(opened));
    $('studioWallToggle').textContent = opened ? '벽 전체 보기' : '앞벽 열기';
    $('studioWallToggle').title = opened ? '열어 둔 벽을 모두 다시 표시합니다.' : '현재 시점의 앞벽만 엽니다. 회전해도 열린 벽은 유지됩니다.';
  };
  $('studioUndo').onclick = () => { closeComparison(); if (!undo()) notify('되돌릴 변경이 없습니다.'); };
  document.querySelectorAll('[data-studio-style]').forEach(button => { button.onclick = () => {
    if (state.customerView || !selectedRoom()) return;
    apply(applyStudioStyle(state.project, selectedRoom().id, button.dataset.studioStyle));
  }; });
  $('studioCompare').onclick = () => {
    const r = selectedRoom(); if (!r) return;
    const review = buildStudioReview(state.project, r.id, getBiz(), state.customerView);
    try {
      $('studioBeforeImage').src = captureProposalRoom(review.beforeProject.rooms.find(x => x.id === r.id), review.beforeProject);
      $('studioAfterImage').src = captureProposalRoom(r, state.project);
      $('studioCompareRange').value = 50;
      $('studioComparison').querySelector('.studio-comparison-images').style.setProperty('--split', '50%');
      $('studioComparison').hidden = false;
      $('studioCompareClose').focus();
    } catch { notify('비교 이미지를 만들지 못했습니다. 3D 화면을 연 뒤 다시 시도하세요.'); }
  };
  // ── AI 디자이너 → 스튜디오: 한 문장 → 마감·조명 제안 → 실측 모델·견적 동시 반영 ──
  let aiBusy = false;
  $('studioAiGo').onclick = async () => {
    if (state.customerView) return notify('고객 열람용 화면에서는 제안만 볼 수 있습니다.');
    const r = selectedRoom(), t = $('studioAiInput').value.trim();
    if (!r) return notify('공간을 먼저 선택하세요.');
    if (!t || aiBusy) return;
    aiBusy = true;
    const btn = $('studioAiGo');
    btn.disabled = true; btn.textContent = 'AI 제안 생성 중…';
    const out = $('studioAiResult');
    out.hidden = false;
    out.textContent = '실측 치수·물량·카탈로그 단가를 기반으로 제안을 만드는 중…';
    try {
      let img = null;
      try { img = aiMod.captureViewpoint(); } catch {}
      const { text, changes } = await aiMod.askDesigner(`(대상 공간: ${r.name}) ${t}`, img);
      track('ai_suggest', changes.length || 1);
      out.replaceChildren();
      const p2 = document.createElement('p');
      p2.textContent = text || '(제안 텍스트 없음)';
      out.append(p2);
      if (changes.length) {
        const list = document.createElement('div');
        list.className = 'studio-ai-changes';
        for (const ch of changes) {
          const li = document.createElement('div');
          li.textContent = '· ' + aiMod.describeChange(ch);
          list.append(li);
        }
        out.append(list);
        const applyBtn = document.createElement('button');
        applyBtn.className = 'studio-button studio-button-primary';
        applyBtn.type = 'button';
        applyBtn.textContent = `제안 ${changes.length}건 모두 적용`;
        applyBtn.onclick = () => {
          pushProjectHistory();   // 배치 1회 undo
          let n = 0;
          for (const ch of changes) if (aiMod.applyChange(ch)) n++;
          track('ai_apply', n);
          applyBtn.textContent = `✓ ${n}건 적용됨 — 모델·견적에 반영`;
          applyBtn.disabled = true;
          $('studioStatus').textContent = 'AI 제안 반영됨 · 되돌리기로 취소 가능';
        };
        out.append(applyBtn);
      } else {
        const none = document.createElement('p');
        none.textContent = '적용 가능한 변경 제안이 없습니다 — 원하는 분위기를 다르게 말해보세요.';
        out.append(none);
      }
    } catch (err) {
      out.textContent = '⚠ ' + (err?.message || err);
    }
    aiBusy = false;
    btn.disabled = false;
    btn.textContent = '제안받기';
  };

  $('studioCompareClose').onclick = closeComparison;
  $('studioCompareRange').oninput = e => $('studioComparison').querySelector('.studio-comparison-images').style.setProperty('--split', e.target.value + '%');
  const comparisonImages = $('studioComparison').querySelector('.studio-comparison-images');
  comparisonImages.style.touchAction = 'none';
  let draggingComparison = null;
  const slide = e => {
    const bounds = comparisonImages.getBoundingClientRect();
    const value = Math.max(0, Math.min(100, (e.clientX - bounds.left) / bounds.width * 100));
    $('studioCompareRange').value = value; comparisonImages.style.setProperty('--split', value + '%');
  };
  comparisonImages.onpointerdown = e => { e.preventDefault(); draggingComparison = e.pointerId; comparisonImages.setPointerCapture(e.pointerId); slide(e); };
  comparisonImages.onpointermove = e => { if (draggingComparison === e.pointerId) slide(e); };
  comparisonImages.onpointerup = comparisonImages.onpointercancel = () => { draggingComparison = null; };
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('studioComparison').hidden) { closeComparison(); $('studioCompare').focus(); } });
  on(what => {
    if (!['project', 'select', 'init', 'mode', 'meta', 'lights', 'rates'].includes(what)) return;
    if (what === 'project') closeComparison();
    render();
    const nextRoom = selectedRoom()?.id;
    if (active && lastRoom !== nextRoom) { lastRoom = nextRoom; closeComparison(); focusScene(); }
  });
  render();
  return { open, go, render };
}
