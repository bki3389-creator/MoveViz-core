// main.js — UI 배선: 헤더/탭/2D 편집 도구/좌측 방 목록/우측 인스펙터/견적/인쇄(도면+견적).

import { state, on, emit, newProject, loadJSONText, saveProjectFile, restore,
         selectedRoom, room, metricsOf, wallsOf, removeLight, undo,
         updateOpening, removeOpening, removeInnerWall, scaleRoom,
         addFurniture, rotateFurniture, resizeFurniture, removeFurniture } from './state.js';
import { init2D, render2d, renderRoomImage, cancelWallDraw } from './plan2d.js';
import { init3D, rebuild3D, frameAll, clearHighlight } from './scene3d.js';
import { renderEstimate, exportCSV, buildEstimate } from './estimate.js';
import { exportDXF } from './dxf.js';
import { FINISH_FLOOR, FINISH_WALL, FINISH_CEIL, CEIL_TYPES, WALL_TYPES, LIGHTS, FURN_ITEMS,
         item, KRW } from './catalog.js';

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
$('chkFurn').onchange = e => { state.showFurniture = e.target.checked; rebuild3D(); render2d(); };
$('btnFrame').onclick = () => frameAll();

function syncToolbar() {
  for (const [id, tool] of TOOLS2D) $(id).classList.toggle('on', (state.tool2d || 'select') === tool);
  $('modeSelect').classList.toggle('on', state.mode === 'select');
  $('modeLight').classList.toggle('on', state.mode === 'light');
  $('lightType').style.opacity = state.mode === 'light' ? 1 : 0.45;
  let hint = '';
  if (state.activeTab === '2d') {
    hint = { door: '벽 클릭 = 문 900 추가', window: '벽 클릭 = 창 1500 추가',
             wall: '두 점 클릭 = 가벽 (Esc 종료)', select: '' }[state.tool2d || 'select'];
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
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault(); clearHighlight(); undo(); return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    const s = state.sel; if (!s) return;
    const r = room(s.roomId); if (!r) return;
    clearHighlight();
    if (s.kind === 'light') removeLight(r, s.lightId);
    else if (s.kind === 'opening') removeOpening(r, s.openingIdx);
    else if (s.kind === 'furniture') removeFurniture(r, s.furnIdx);
    else if (s.kind === 'wall' && /^[xz]\d+_\d+$/.test(s.wallKey)) removeInnerWall(r, s.wallKey);
  }
  if (e.key === 'Escape') {
    state.pendingLine = null; state.mode = 'select'; state.tool2d = 'select';
    cancelWallDraw(); syncToolbar();
  }
  if (e.key.toLowerCase() === 'r' && state.sel?.kind === 'furniture') {
    const r = room(state.sel.roomId);
    if (r) rotateFurniture(r, state.sel.furnIdx);
  }
});

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
    op.textContent = o.rate != null
      ? `${o.name} (${KRW(o.rate)}원/${o.unit === 'm2' ? '㎡' : o.unit === 'm' ? 'm' : '개'})` : o.name;
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
    el.appendChild(btn('90° 회전 (R)', '', () => rotateFurniture(r, s.furnIdx)));
    el.appendChild(btn('삭제 (Del)', 'danger', () => removeFurniture(r, s.furnIdx)));
    el.appendChild(tip('2D에서 드래그로 이동합니다.'));
  } else if (s?.kind === 'wall' && s.roomId === r.id) {
    const w = wallsOf(r).find(x => x.key === s.wallKey);
    head.innerHTML = `<b>${esc(r.name)} · ${w?.inner ? '내부 벽' : '외곽 벽'} ${s.wallKey}</b>
      <span>길이 ${w ? mmOf(w.len).toLocaleString() : '?'}mm · 순면적 ${w ? w.netArea.toFixed(1) : '?'}㎡ · 개구부 ${w?.openings.length ?? 0}</span>`;
    el.appendChild(head);
    el.appendChild(sel('이 벽 마감(개별)', FINISH_WALL, r.wallOverrides[s.wallKey] || '',
      v => { if (v) r.wallOverrides[s.wallKey] = v; else delete r.wallOverrides[s.wallKey]; emit('project'); },
      [{ id: '', name: '기본과 동일' }]));
    el.appendChild(sel('벽체 유형', WALL_TYPES, r.wallTypes[s.wallKey] || 'wt_keep', v => {
      if (v === 'wt_keep') delete r.wallTypes[s.wallKey]; else r.wallTypes[s.wallKey] = v;
      emit('project');
    }));
    if (w?.inner) el.appendChild(btn('가벽 삭제 (Del)', 'danger', () => removeInnerWall(r, s.wallKey)));
    el.appendChild(tip('2D에서 벽을 드래그하면 위치가 이동합니다(개구부 동반).'));
  } else if (s?.kind === 'light' && s.roomId === r.id) {
    const l = r.lights.find(x => x.id === s.lightId);
    const li = l && item(l.type);
    head.innerHTML = `<b>${esc(r.name)} · ${li?.name ?? '조명'}</b>
      <span>${li?.kind === 'line' && l.x2 != null ? '길이 ' + Math.hypot(l.x2 - l.x, l.z2 - l.z).toFixed(2) + 'm' : `위치 (${l?.x.toFixed(2)}, ${l?.z.toFixed(2)})`}</span>`;
    el.appendChild(head);
    el.appendChild(btn('이 조명 삭제 (Del)', 'danger', () => { clearHighlight(); removeLight(r, s.lightId); }));
  } else {
    head.innerHTML = `<b>${esc(r.name)}</b>
      <span>${m.area.toFixed(2)}㎡ · ${m.pyeong.toFixed(1)}평 · CH ${mmOf(m.H)} · 벽 순면적 ${m.wallNet.toFixed(1)}㎡ · 문${m.doors} 창${m.windows}</span>`;
    el.appendChild(head);
    const nameIn = document.createElement('input');
    nameIn.value = r.name;
    nameIn.onchange = () => { r.name = nameIn.value; emit('project'); };
    el.appendChild(fld('방 이름', nameIn));
    el.appendChild(sel('바닥 마감', FINISH_FLOOR, r.floorFinish, v => { r.floorFinish = v; emit('project'); }));
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
    el.appendChild(det);
    el.appendChild(tip('3D에서 벽·바닥·천장·가구·조명을 클릭하면 개별 편집. 2D 도구로 문/창/가벽 추가. Ctrl+Z 되돌리기.'));
  }
}

function tip(text) {
  const d = document.createElement('div');
  d.className = 'tip'; d.textContent = text;
  return d;
}
