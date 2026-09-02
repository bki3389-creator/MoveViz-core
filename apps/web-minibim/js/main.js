// main.js — UI 배선: 헤더/탭/2D 편집 도구/좌측 방 목록/우측 인스펙터/견적/인쇄(도면+견적).

import { state, on, emit, newProject, loadJSONText, saveProjectFile, restore, addExtra, setExtraQty, straightenRoom, flipDoor,
         selectedRoom, room, metricsOf, wallsOf, removeLight, undo,
         updateOpening, removeOpening, removeInnerWall, scaleRoom,
         addFurniture, rotateFurniture, resizeFurniture, removeFurniture, arrangeRooms } from './state.js';
import { init2D, render2d, renderRoomImage, cancelWallDraw } from './plan2d.js';
import * as stateMod from './state.js';
import { init3D, rebuild3D, frameAll, clearHighlight, getSceneRefs } from './scene3d.js';
import { renderEstimate, exportCSV, buildEstimate } from './estimate.js';
import { exportDXF } from './dxf.js';
import { FINISH_FLOOR, FINISH_WALL, FINISH_CEIL, CEIL_TYPES, WALL_TYPES, LIGHTS, FURN_ITEMS, furnKgOf, ratesOf,
         WORK_ITEMS, workItem, workGrade, roomTypeOf, item, KRW, canonId, unitKo2 } from './catalog.js';

const $ = id => document.getElementById(id);
const mmOf = m => Math.round(m * 1000);

// ── 초기화 ──────────────────────────────────────
init2D($('cv2d'));
init3D($('view3d'));
state.tool2d = 'select';

if (!restore()) state.project = newProject();
$('projName').value = state.project.name || '';

on(what => {
  if (what === 'project' || what === 'lights' || what === 'init') rebuild3D();
  if (what === 'project') $('projName').value = state.project?.name ?? '';
  render2d();
  renderRooms();
  renderInspector();
  renderEstimate($('estSummary'), $('estTable'));
  if (what === 'tool') syncToolbar();
});
rebuild3D(); frameAll(); emit('init');

// URL 파라미터 — 스크린샷/딥링크 검증용: ?sample(샘플 자동 로드) &tab=2d|3d &room=이름 &ceil=1
(async () => {
  const q = new URLSearchParams(location.search);
  if (q.has('sample')) {
    try {
      const res = await fetch('./sample/sample_project.json');
      loadJSONText(await res.text(), 'sample');
      frameAll();
    } catch {}
  }
  if (q.get('room')) {
    const r = (state.project?.rooms || []).find(x => x.name === q.get('room'));
    if (r) { state.selRoom = r.id; state.sel = { kind: 'room', roomId: r.id }; }
  }
  if (q.get('ceil') === '1') { state.showCeiling = true; $('chkCeil').checked = true; }
  if (q.get('tab') === '2d' || q.get('tab') === '3d') setTab(q.get('tab'));
  if (q.has('rendershot')) setTimeout(() => runRenderShot(Number(q.get('rendershot')) || 24, 640, 400), 800);
  if (q.has('sample') || q.get('ceil') === '1') { rebuild3D(); emit('select'); }
})();

// ── 헤더 ──────────────────────────────────────
$('projName').addEventListener('change', e => { state.project.name = e.target.value; emit('meta'); });
$('btnSample').onclick = async () => {
  const res = await fetch('./sample/sample_project.json');
  loadJSONText(await res.text(), 'sample');
  frameAll();
};
$('btnOpen').onclick = () => $('fileIn').click();
$('fileIn').addEventListener('change', async e => {
  for (const f of e.target.files) loadJSONText(await f.text(), f.name);
  frameAll(); e.target.value = '';
});
$('btnSave').onclick = () => saveProjectFile();
$('btnCSV').onclick = () => exportCSV();
$('btnDXF').onclick = () => exportDXF();
$('btnPrint').onclick = () => window.print();
$('btnNew').onclick = () => {
  if (!confirm('현재 프로젝트를 비우고 새로 시작할까요? (저장 안 한 내용은 사라짐)')) return;
  state.project = newProject($('projName').value || '새 현장');
  state.sel = null; state.selRoom = null;
  emit('project'); frameAll();
};

for (const ev of ['dragover', 'drop']) document.body.addEventListener(ev, e => e.preventDefault());
document.body.addEventListener('drop', async e => {
  for (const f of e.dataTransfer.files) if (f.name.endsWith('.json')) loadJSONText(await f.text(), f.name);
  frameAll();
});

// ── 인쇄: 요약 + 방별 도면 이미지 + 견적표 ──────────────
window.addEventListener('beforeprint', () => {
  // 미커밋 단가 입력값을 속성으로 커밋 (innerHTML 복사 대비)
  document.querySelectorAll('#estTable .rate-in').forEach(i => i.setAttribute('value', i.value));
  const pa = $('printArea');
  const P = state.project;
  const name = P?.name || '현장';
  let html = `<h2>${esc(name)} — 실측 도면 · 개략 견적</h2>`;
  const df = new Date();
  html += `<p class="pmeta">${esc(P?.company || 'PlanShot')} · ${df.getFullYear()}.${df.getMonth() + 1}.${df.getDate()} · iPhone LiDAR 실측</p>`;
  html += $('estSummary').innerHTML;
  for (const r of P?.rooms || []) {
    const img = renderRoomImage(r, 1000, 700);
    if (!img) continue;
    const m = metricsOf(r);
    html += `<div class="proom"><h3>${esc(r.name)}
      <small>${m.area.toFixed(2)}㎡ · ${m.pyeong.toFixed(1)}평 · ${mmOf(m.w).toLocaleString()} × ${mmOf(m.d).toLocaleString()} · CH ${mmOf(m.H)}</small></h3>
      <img src="${img}"></div>`;
  }
  html += '<h3 class="pbreak">견적 상세</h3>' + $('estTable').innerHTML;
  html += `<p class="disc">개략 실측 — 시공 발주 전 정밀실측 필요 · PlanShot 미니BIM</p>`;
  pa.innerHTML = html;
});
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

// ── 탭/툴바 ──────────────────────────────────────
function setTab(t) {
  $('pane2d').style.display = t === '2d' ? '' : 'none';
  $('pane3d').style.display = t === '3d' ? '' : 'none';
  $('tab2d').classList.toggle('on', t === '2d');
  $('tab3d').classList.toggle('on', t === '3d');
  state.activeTab = t;
  if (t === '2d') render2d();
  syncToolbar();
}
$('tab2d').onclick = () => setTab('2d');
$('tab3d').onclick = () => setTab('3d');

// 2D 편집 도구
const TOOLS2D = [['t2Select', 'select'], ['t2Door', 'door'], ['t2Window', 'window'], ['t2Wall', 'wall']];
for (const [id, tool] of TOOLS2D) {
  $(id).onclick = () => {
    state.tool2d = tool;
    if (tool !== 'wall') cancelWallDraw();
    if (tool !== 'select') setTab('2d');
    syncToolbar();
  };
}

// 3D 조명 도구
$('modeSelect').onclick = () => { state.mode = 'select'; state.pendingLine = null; syncToolbar(); };
$('modeLight').onclick = () => { state.mode = 'light'; setTab('3d'); syncToolbar(); };
const lightSel = $('lightType');
LIGHTS.forEach(l => { const o = document.createElement('option'); o.value = l.id; o.textContent = l.name; lightSel.appendChild(o); });
lightSel.value = state.lightType;
lightSel.onchange = () => { state.lightType = lightSel.value; syncToolbar(); };
$('chkCeil').onchange = e => { state.showCeiling = e.target.checked; rebuild3D(); };
$('chkFX').onchange = e => { state.lightFX = e.target.checked; rebuild3D(); };
$('chkFurn').onchange = e => { state.showFurniture = e.target.checked; rebuild3D(); render2d(); };
$('btnFrame').onclick = () => frameAll();
$('btnShot').onclick = () => runRenderShot();
/// 실내 시점: 선택한 방 안 눈높이 1.4m 코너 근처에서 방 중심을 바라봄.
function interiorPose() {
  const r = selectedRoom(); if (!r) return null;
  const { layoutOffsets, bboxOf } = stateMod;
  const off = layoutOffsets()[r.id]; const bb = off?.bb; if (!bb) return null;
  const cx = off.x + (bb.minX + bb.maxX) / 2, cz = off.z + (bb.minZ + bb.maxZ) / 2;
  const w2 = bb.maxX - bb.minX, d2 = bb.maxZ - bb.minZ;
  // 방 안쪽 코너(문 반대편 대각) 근처에 카메라
  const px = cx - w2 * 0.36, pz = cz + d2 * 0.36;
  return { pos: [px, 1.4, pz], look: [cx + w2 * 0.12, 1.15, cz - d2 * 0.15], fov: 64 };
}
async function runRenderShot(sampleTarget = 200, w = 1280, h = 800, mode = 'auto') {
  const { renderShot, stopRender, isRendering } = await import('./render.js');
  if (isRendering()) return;
  setTab('3d');
  const modal = $('shotModal'), cv2 = $('shotCanvas');
  modal.hidden = false;
  $('shotSave').style.display = 'none';
  $('shotProg').textContent = '준비 중…';
  $('shotStop').onclick = () => stopRender();
  $('shotClose').onclick = () => { stopRender(); modal.hidden = true; };
  $('shotView').onclick = () => { stopRender(); setTimeout(() => runRenderShot(sampleTarget, w, h,
    mode === 'overview' || (mode === 'auto' && interiorPose()) ? 'overview2' : 'auto'), 300); };
  // overview2 → 실내↔전체 토글용: 'overview'로 정규화
  if (mode === 'overview2') mode = 'overview';
  const { root, camera } = getSceneRefs();
  const pose = mode === 'overview' ? null : interiorPose();
  $('shotProg').textContent = pose ? '실내 뷰 렌더 중…' : '전체 뷰 렌더 중…';
  const url = await renderShot(root, camera, cv2, {
    width: w, height: h, samples: sampleTarget, camPose: pose,
    onProgress: (n, t) => { $('shotProg').textContent = `${pose ? '실내' : '전체'} 뷰 · 샘플 ${n}/${t}`; },
  });
  if (url) {
    $('shotProg').textContent += ' · 완료';
    const a = $('shotSave');
    a.href = url;
    a.download = (state.project?.name || '미니빔') + '_렌더샷.png';
    a.style.display = '';
  } else {
    $('shotProg').textContent = '렌더 실패 (콘솔 확인)';
  }
}
$('btnArrange').onclick = () => { if (confirm('방 배치를 일렬로 초기화할까요?')) { arrangeRooms(); frameAll(); } };

function syncToolbar() {
  for (const [id, tool] of TOOLS2D) $(id).classList.toggle('on', (state.tool2d || 'select') === tool);
  $('modeSelect').classList.toggle('on', state.mode === 'select');
  $('modeLight').classList.toggle('on', state.mode === 'light');
  $('lightType').style.opacity = state.mode === 'light' ? 1 : 0.45;
  let hint = '';
  if (state.activeTab === '2d') {
    hint = { door: '벽 클릭 = 문 900 추가 · 배치 후 Space 방향', window: '벽 클릭 = 창 1500 추가',
             wall: '두 점 클릭 = 가벽(수평/수직 자동) · Esc 종료',
             select: 'Space 방향전환 · E/Del 삭제 · D문 Q창 W가벽' }[state.tool2d || 'select'];
  } else if (state.mode === 'light') {
    hint = item(state.lightType)?.kind === 'line' ? '천장/바닥 두 번 클릭 = 라인조명' : '천장/바닥 클릭 = 조명 설치';
  }
  $('lightHint').textContent = hint;
}
setTab('3d');

// ── 키보드 ──────────────────────────────────────
document.addEventListener('keydown', e => {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;   // 입력 중 가드
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') {
    e.preventDefault(); clearHighlight(); undo(); return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace' || k === 'e') { deleteSelected(); return; }
  if (e.key === 'Escape') {
    state.pendingLine = null; state.mode = 'select'; state.tool2d = 'select';
    cancelWallDraw(); syncToolbar(); return;
  }
  if (e.key === ' ') {   // Space = 가구 90° 회전 / 문 방향 4상태(경첩·스윙) 순환
    const s2 = state.sel; const r = s2 && room(s2.roomId);
    if (r && s2.kind === 'furniture') { e.preventDefault(); rotateFurniture(r, s2.furnIdx); }
    else if (r && s2.kind === 'opening') {
      const o = r.plan.openings[s2.openingIdx];
      if (o && o.type !== 'window') { e.preventDefault(); flipDoor(r, s2.openingIdx); }
    }
    return;
  }
  if (k === 'r' && state.sel?.kind === 'furniture') {
    const r = room(state.sel.roomId);
    if (r) rotateFurniture(r, state.sel.furnIdx);
    return;
  }
  // 도구 단축키 (원본 미니빔과 동일: V 선택 · D 문 · Q 창 · W 가벽)
  if (k === 'v') { state.tool2d = 'select'; syncToolbar(); }
  if (k === 'd') { state.tool2d = 'door'; setTab('2d'); syncToolbar(); }
  if (k === 'q') { state.tool2d = 'window'; setTab('2d'); syncToolbar(); }
  if (k === 'w') { state.tool2d = 'wall'; cancelWallDraw(); setTab('2d'); syncToolbar(); }
});
function deleteSelected() {
  const s = state.sel; if (!s) return;
  const r = room(s.roomId); if (!r) return;
  clearHighlight();
  if (s.kind === 'light') removeLight(r, s.lightId);
  else if (s.kind === 'opening') removeOpening(r, s.openingIdx);
  else if (s.kind === 'furniture') removeFurniture(r, s.furnIdx);
  else if (s.kind === 'wall' && /^[xz]\d+_\d+$/.test(s.wallKey)) removeInnerWall(r, s.wallKey);
}

// ── 좌측: 방 목록 ──────────────────────────────────
function renderRooms() {
  const el = $('roomList');
  const rooms = state.project?.rooms || [];
  if (!rooms.length) {
    el.innerHTML = '<div class="empty">방 없음 — 앱에서 뽑은 plan.json 을<br>드래그하거나 샘플을 여세요</div>';
    return;
  }
  el.innerHTML = '';
  for (const r of rooms) {
    const m = metricsOf(r);
    const d = document.createElement('div');
    d.className = 'room-card' + (state.selRoom === r.id ? ' on' : '');
    d.innerHTML = `<div class="rc-top"><b>${esc(r.name)}</b><span>${m.area.toFixed(1)}㎡ · ${m.pyeong.toFixed(1)}평</span></div>
      <div class="rc-sub">${item(r.floorFinish)?.name ?? ''} · ${item(r.wallFinish)?.name ?? ''} · 조명 ${r.lights.length}</div>`;
    d.onclick = () => { state.selRoom = r.id; state.sel = { kind: 'room', roomId: r.id }; emit('select'); };
    const del = document.createElement('button');
    del.className = 'rc-del'; del.textContent = '×'; del.title = '방 제거';
    del.onclick = ev => {
      ev.stopPropagation();
      if (!confirm(`'${r.name}' 방을 제거할까요?`)) return;
      state.project.rooms = state.project.rooms.filter(x => x.id !== r.id);
      if (state.selRoom === r.id) state.selRoom = state.project.rooms[0]?.id || null;
      state.sel = null; emit('project');
    };
    d.appendChild(del);
    el.appendChild(d);
  }
}

// ── 우측: 인스펙터 ──────────────────────────────────
function fld(label, inner) {
  const w = document.createElement('label');
  w.className = 'fld';
  w.innerHTML = `<span>${label}</span>`;
  w.appendChild(inner);
  return w;
}
function sel(label, options, value, onchange, extra) {
  const s = document.createElement('select');
  for (const o of (extra || []).concat(options)) {
    const op = document.createElement('option');
    op.value = o.id;
    const tot = (o.mat ?? 0) + (o.lab ?? 0);
    op.textContent = (o.mat != null || o.lab != null)
      ? `${o.name} (${KRW(tot)}원/${o.unit === 'm2' ? '㎡' : o.unit === 'm' ? 'm' : '개'})` : o.name;
    s.appendChild(op);
  }
  s.value = value ?? (extra?.[0]?.id ?? options[0].id);
  s.onchange = () => onchange(s.value);
  return fld(label, s);
}
function numFld(label, valueMM, onapply) {
  const i = document.createElement('input');
  i.type = 'text'; i.inputMode = 'numeric'; i.value = valueMM;
  i.addEventListener('change', () => {
    const v = Number(String(i.value).replace(/[^\d]/g, ''));
    if (v > 0) onapply(v);
  });
  return fld(label, i);
}
function btn(text, cls, fn) {
  const b = document.createElement('button');
  b.className = 'btn ' + (cls || ''); b.textContent = text; b.onclick = fn;
  b.style.width = '100%'; b.style.marginTop = '6px';
  return b;
}

function renderInspector() {
  const el = $('inspector');
  el.innerHTML = '';
  const r = selectedRoom();
  if (!r) { el.innerHTML = '<div class="empty">방을 선택하세요</div>'; return; }
  const m = metricsOf(r);
  const head = document.createElement('div');
  head.className = 'insp-head';
  const s = state.sel;

  if (s?.kind === 'opening' && s.roomId === r.id) {
    const op = r.plan.openings[s.openingIdx];
    if (!op) { state.sel = null; return renderInspector(); }
    const isWin = op.type === 'window';
    head.innerHTML = `<b>${esc(r.name)} · ${isWin ? '창' : '문'}</b>
      <span>폭 ${mmOf(op.width ?? Math.abs(op.span[1] - op.span[0]))}mm · 높이 ${mmOf(op.height ?? (isWin ? 1.2 : 2.1))}mm</span>`;
    el.appendChild(head);
    el.appendChild(numFld('폭 (mm)', mmOf(op.width ?? Math.abs(op.span[1] - op.span[0])),
      v => updateOpening(r, s.openingIdx, { width: v / 1000 })));
    el.appendChild(numFld('높이 (mm)', mmOf(op.height ?? (isWin ? 1.2 : 2.1)),
      v => updateOpening(r, s.openingIdx, { height: v / 1000 })));
    const tsel = sel('종류', [{ id: 'door', name: '문' }, { id: 'window', name: '창' }], op.type,
      v => updateOpening(r, s.openingIdx, { type: v }));
    el.appendChild(tsel);
    el.appendChild(btn('삭제 (Del)', 'danger', () => removeOpening(r, s.openingIdx)));
    el.appendChild(tip('2D에서 드래그하면 벽을 따라 이동합니다. 벽 순면적·견적에 즉시 반영.'));
  } else if (s?.kind === 'furniture' && s.roomId === r.id) {
    const f = r.plan.furniture[s.furnIdx];
    if (!f) { state.sel = null; return renderInspector(); }
    const cs = f.obb || f.polygon;
    const w = Math.hypot(cs[1][0] - cs[0][0], cs[1][1] - cs[0][1]);
    const d = Math.hypot(cs[3][0] - cs[0][0], cs[3][1] - cs[0][1]);
    head.innerHTML = `<b>${esc(r.name)} · ${esc(f.category_ko || f.category || '가구')}</b>
      <span>${mmOf(w)} × ${mmOf(d)} mm · 회전 ${Math.round(f.yaw_deg || 0)}°</span>`;
    el.appendChild(head);
    el.appendChild(numFld('폭 (mm)', mmOf(w), v => resizeFurniture(r, s.furnIdx, v / 1000, d)));
    el.appendChild(numFld('깊이 (mm)', mmOf(d), v => resizeFurniture(r, s.furnIdx, w, v / 1000)));
    el.appendChild(priceKg(f, w, d));
    el.appendChild(btn('90° 회전 (Space/R)', '', () => rotateFurniture(r, s.furnIdx)));
    el.appendChild(btn('삭제 (Del)', 'danger', () => removeFurniture(r, s.furnIdx)));
    el.appendChild(tip('2D에서 드래그로 이동합니다.'));
  } else if (s?.kind === 'wall' && s.roomId === r.id) {
    const w = wallsOf(r).find(x => x.key === s.wallKey);
    const wallKindLabel = w?.inner ? '실내 가벽' : (w?.isExterior ? '🧱 외벽(외기)' : '내벽(세대 내)');
    head.innerHTML = `<b>${esc(r.name)} · ${wallKindLabel} ${s.wallKey}</b>
      <span>길이 ${w ? mmOf(w.len).toLocaleString() : '?'}mm · 순면적 ${w ? w.netArea.toFixed(1) : '?'}㎡ · 개구부 ${w?.openings.length ?? 0}</span>`;
    el.appendChild(head);
    el.appendChild(sel('이 벽 마감(개별)', FINISH_WALL, r.wallOverrides[s.wallKey] || '',
      v => { if (v) r.wallOverrides[s.wallKey] = v; else delete r.wallOverrides[s.wallKey]; emit('project'); },
      [{ id: '', name: '기본과 동일' }]));
    el.appendChild(sel('벽체 유형', WALL_TYPES, r.wallTypes[s.wallKey] || 'wt_keep', v => {
      if (v === 'wt_demo' && w?.isExterior
          && !confirm('⚠️ 외벽(외기 접함)입니다. 인테리어 공사에서 외벽/구조벽 철거는 불가합니다.\n그래도 철거로 표시할까요?')) {
        emit('select'); return;   // 셀렉트 되돌림
      }
      if (v === 'wt_keep') delete r.wallTypes[s.wallKey]; else r.wallTypes[s.wallKey] = v;
      emit('project');
    }));
    if (w?.isExterior) el.appendChild(tip('외벽 — 샷시/창호 교체는 "추가 공사 > 창호"로. 철거·이동 불가.'));
    if (w?.inner) el.appendChild(btn('가벽 삭제 (Del)', 'danger', () => removeInnerWall(r, s.wallKey)));
    el.appendChild(tip('2D에서 벽을 드래그하면 위치가 이동합니다(개구부 동반).'));
  } else if (s?.kind === 'light' && s.roomId === r.id) {
    const l = r.lights.find(x => x.id === s.lightId);
    const li = l && item(l.type);
    head.innerHTML = `<b>${esc(r.name)} · ${li?.name ?? '조명'}</b>
      <span>${li?.kind === 'line' && l.x2 != null ? '길이 ' + Math.hypot(l.x2 - l.x, l.z2 - l.z).toFixed(2) + 'm' : `위치 (${l?.x.toFixed(2)}, ${l?.z.toFixed(2)})`}</span>`;
    el.appendChild(head);
    if (li) {   // 이 조명의 견적 단가 — 선택한 객체의 비용만 표시
      const rr = ratesOf(l.type, state.project?.rates);
      const qty = li.kind === 'line' && l.x2 != null ? Math.hypot(l.x2 - l.x, l.z2 - l.z) : 1;
      el.appendChild(priceChip(li.name, rr.m, rr.l, qty, li.kind === 'line' ? 'm' : 'ea'));
    }
    el.appendChild(btn('이 조명 삭제 (Del)', 'danger', () => { clearHighlight(); removeLight(r, s.lightId); }));
  } else {
    head.innerHTML = `<b>${esc(r.name)}</b>
      <span>${m.area.toFixed(2)}㎡ · ${m.pyeong.toFixed(1)}평 · CH ${mmOf(m.H)} · 벽 순면적 ${m.wallNet.toFixed(1)}㎡ · 문${m.doors} 창${m.windows}</span>`;
    el.appendChild(head);
    const nameIn = document.createElement('input');
    nameIn.value = r.name;
    nameIn.onchange = () => { r.name = nameIn.value; emit('project'); };
    el.appendChild(fld('방 이름', nameIn));
    el.appendChild(sel('바닥 마감', FINISH_FLOOR, canonId(r.floorFinish), v => { r.floorFinish = v; emit('project'); }));
    el.appendChild(sel('벽 마감(기본)', FINISH_WALL, r.wallFinish, v => { r.wallFinish = v; emit('project'); }));
    el.appendChild(sel('천장 마감', FINISH_CEIL, r.ceilFinish, v => { r.ceilFinish = v; emit('project'); }));
    el.appendChild(sel('천장 유형', CEIL_TYPES, r.ceilingType, v => { r.ceilingType = v; emit('project'); }));

    // 가구 추가
    const fs = document.createElement('select');
    FURN_ITEMS.forEach((f, i) => {
      const op = document.createElement('option');
      op.value = i; op.textContent = `${f.name} (${mmOf(f.w)}×${mmOf(f.d)})`;
      fs.appendChild(op);
    });
    el.appendChild(fld('가구 추가', fs));
    el.appendChild(btn('+ 방 가운데에 추가', '', () => {
      const f = FURN_ITEMS[+fs.value];
      const bb = { x: (m.w / 2), z: (m.d / 2) };
      const b2 = r.plan.boundary;
      const cx = b2 ? b2.reduce((a, p) => a + p[0], 0) / b2.length : bb.x;
      const cz = b2 ? b2.reduce((a, p) => a + p[1], 0) / b2.length : bb.z;
      const idx = addFurniture(r, f.category, f.name, f.w, f.d, cx, cz);
      state.sel = { kind: 'furniture', roomId: r.id, furnIdx: idx };
      emit('select');
    }));

    // 공사 항목 (75항목 체계: 등급 3단 + 자동수량 + 연동)
    const wSel = document.createElement('select');
    let lastG2 = '', og2 = null;
    for (const wi2 of WORK_ITEMS) {
      if (wi2.group !== lastG2) { og2 = document.createElement('optgroup'); og2.label = wi2.group; wSel.appendChild(og2); lastG2 = wi2.group; }
      const op2 = document.createElement('option');
      op2.value = wi2.id; op2.textContent = wi2.name;
      og2.appendChild(op2);
    }
    const gSel = document.createElement('select');
    const qIn = document.createElement('input');
    qIn.inputMode = 'decimal';
    const syncWork = () => {
      const wi2 = workItem(wSel.value); if (!wi2) return;
      gSel.innerHTML = '';
      wi2.grades.forEach((gr, i) => {
        const op3 = document.createElement('option');
        op3.value = i;
        op3.textContent = `${gr.g} (${KRW(gr.mat + gr.lab)}원/${unitKo2(wi2.unit)})`;
        gSel.appendChild(op3);
      });
      const aq = autoQtyFor(r, wi2);
      qIn.value = aq ?? '';
      qIn.placeholder = aq != null ? `자동 ${aq}` : '수량';
    };
    wSel.onchange = syncWork;
    syncWork();
    el.appendChild(fld('공사 항목 (창호·문·주방·욕실·설비…)', wSel));
    el.appendChild(fld('등급/사양', gSel));
    el.appendChild(fld(`수량 (${unitKo2(workItem(wSel.value)?.unit || 'ea')}) — 실측 자동 제안, 수정 가능`, qIn));
    el.appendChild(btn('+ 이 실에 추가', '', () => {
      const wi2 = workItem(wSel.value); if (!wi2) return;
      const q = Number(String(qIn.value).replace(/[^\d.]/g, '')) || autoQtyFor(r, wi2) || 1;
      addExtra(r, `${wi2.id}#${gSel.value || 0}`, q);
      // 연동 항목 제안 (인덕션→전용선, 욕조철거→방수, 발코니확장→샷시)
      for (const depId of wi2.deps || []) {
        if ((r.extras || []).some(x => x.id.startsWith(depId + '#'))) continue;
        const dep = workItem(depId); if (!dep) continue;
        if (confirm(`연동 항목 '${dep.name}'도 함께 추가할까요?`)) {
          addExtra(r, `${depId}#0`, autoQtyFor(r, dep) || 1);
        }
      }
    }));
    if (r.extras?.length) {
      const list = document.createElement('div');
      for (const ex of r.extras) {
        const it2 = item(ex.id); if (!it2) continue;
        const row2 = document.createElement('div');
        row2.style.cssText = 'display:flex;align-items:center;gap:6px;margin:4px 0;font-size:12px';
        const qin = document.createElement('input');
        qin.value = ex.qty; qin.inputMode = 'decimal';
        qin.style.cssText = 'width:52px;text-align:right;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:3px 5px;color:var(--ink)';
        qin.onchange = () => setExtraQty(r, ex.id, Number(qin.value) || 0);
        const del2 = document.createElement('button');
        del2.textContent = '×'; del2.style.cssText = 'background:none;border:none;color:var(--danger);cursor:pointer;font-size:14px';
        del2.onclick = () => setExtraQty(r, ex.id, 0);
        const lbl = document.createElement('span');
        lbl.style.flex = '1';
        lbl.textContent = `${it2.name} · ${it2.spec} (${unitKo2(it2.unit)})`;
        row2.append(lbl, qin, del2);
        list.appendChild(row2);
      }
      el.appendChild(list);
    }

    // 실측 보정 (레이저)
    const det = document.createElement('details');
    det.innerHTML = '<summary style="font-size:11px;color:var(--sub);cursor:pointer;margin:8px 0 4px">실측 보정 (레이저 값으로 스케일)</summary>';
    const wIn = document.createElement('input'); wIn.placeholder = `가로 mm (현재 ${mmOf(m.w)})`; wIn.inputMode = 'numeric';
    const dIn = document.createElement('input'); dIn.placeholder = `세로 mm (현재 ${mmOf(m.d)})`; dIn.inputMode = 'numeric';
    det.appendChild(fld('레이저 가로 (mm)', wIn));
    det.appendChild(fld('레이저 세로 (mm)', dIn));
    det.appendChild(btn('보정 적용', '', () => {
      const wv = Number(wIn.value.replace(/[^\d]/g, '')) / 1000 || 0;
      const dv = Number(dIn.value.replace(/[^\d]/g, '')) / 1000 || 0;
      if (wv || dv) scaleRoom(r, wv, dv);
    }));
    det.appendChild(btn('직교 보정 (비뚤어진 스캔 펴기)', '', () => {
      const changed = straightenRoom(r);
      alert(changed ? '지배축 기준으로 회전·10mm 스냅했습니다.' : '이미 직교에 가깝습니다 (10mm 스냅만 적용).');
    }));
    el.appendChild(det);
    el.appendChild(tip('3D에서 벽·바닥·천장·가구·조명을 클릭하면 개별 편집. 2D 도구로 문/창/가벽 추가. Ctrl+Z 되돌리기.'));
  }
}

/// 공사 항목 자동 수량: 리서치 §0 실측 입력값 규칙 (A_floor/A_wall/P/개소/창면적)
function autoQtyFor(r, wi) {
  const rule = wi.auto;
  if (!rule || rule.basis === 'manual') return null;
  if (rule.roomType && roomTypeOf(r.name) !== rule.roomType) return null;
  const m = metricsOf(r);
  const v = { A_floor: m.area, A_wall: m.wallNet, P: m.per, P_door: m.baseboard,
              N_door: m.doors, N_win: m.windows, A_win: m.winArea, room: 1,
              W_furn: furnTons(r) }[rule.basis];
  if (v == null || v <= 0.001) return null;
  return Math.round(v * (rule.factor || 1) * 100) / 100;
}

/// 방 가구 총 무게(톤, 0.1 단위) — '가구 반출·폐기' 자동 수량
function furnTons(r) {
  const kg = (r.plan.furniture || []).reduce((a2, f) => {
    const cs = f.obb || f.polygon || []; if (cs.length < 4) return a2;
    const fw = Math.hypot(cs[1][0] - cs[0][0], cs[1][1] - cs[0][1]);
    const fd = Math.hypot(cs[3][0] - cs[0][0], cs[3][1] - cs[0][1]);
    return a2 + furnKgOf(f.category, fw, fd);
  }, 0);
  return Math.round(kg / 100) / 10;
}

function priceKg(f, w, d) {
  const el2 = document.createElement('div');
  el2.className = 'tip price';
  el2.textContent = `추정 무게 ~${furnKgOf(f.category, w, d)}kg — 철거 시 '가구 반출·폐기' 수량에 반영`;
  return el2;
}

function priceChip(label, mWon, lWon, qty, unit) {
  const d = document.createElement('div');
  d.className = 'tip price';
  d.textContent = `${label} — 재료 ${KRW(Math.round(mWon * qty))} + 노무 ${KRW(Math.round(lWon * qty))} = ${KRW(Math.round((mWon + lWon) * qty))}원`
    + (unit === 'm' ? ` (${qty.toFixed(1)}m)` : '');
  return d;
}

function tip(text) {
  const d = document.createElement('div');
  d.className = 'tip'; d.textContent = text;
  return d;
}
