// main.js — UI 배선: 헤더/탭/좌측 방 목록/우측 인스펙터(유형·재료·조명)/견적.

import { state, on, emit, newProject, loadJSONText, saveProjectFile, restore,
         selectedRoom, room, metricsOf, wallsOf, removeLight } from './state.js';
import { init2D, render2d } from './plan2d.js';
import { init3D, rebuild3D, frameAll, clearHighlight } from './scene3d.js';
import { renderEstimate, exportCSV } from './estimate.js';
import { FINISH_FLOOR, FINISH_WALL, FINISH_CEIL, CEIL_TYPES, WALL_TYPES, LIGHTS, item, KRW } from './catalog.js';

const $ = id => document.getElementById(id);

// ── 초기화 ──────────────────────────────────────
init2D($('cv2d'));
init3D($('view3d'));

if (!restore()) state.project = newProject();
$('projName').value = state.project.name || '';

on(what => {
  if (what === 'project' || what === 'lights' || what === 'rates') { rebuild3D(); }
  render2d();
  renderRooms();
  renderInspector();
  renderEstimate($('estSummary'), $('estTable'));
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
$('btnPrint').onclick = () => window.print();
$('btnNew').onclick = () => {
  if (!confirm('현재 프로젝트를 비우고 새로 시작할까요? (저장 안 한 내용은 사라짐)')) return;
  state.project = newProject($('projName').value || '새 현장');
  state.sel = null; state.selRoom = null;
  emit('project'); frameAll();
};

// 드래그&드롭 (plan.json / 프로젝트 JSON)
for (const ev of ['dragover', 'drop']) document.body.addEventListener(ev, e => e.preventDefault());
document.body.addEventListener('drop', async e => {
  for (const f of e.dataTransfer.files) if (f.name.endsWith('.json')) loadJSONText(await f.text(), f.name);
  frameAll();
});

// ── 탭/툴바 ──────────────────────────────────────
function setTab(t) {
  $('pane2d').style.display = t === '2d' ? '' : 'none';
  $('pane3d').style.display = t === '3d' ? '' : 'none';
  $('tab2d').classList.toggle('on', t === '2d');
  $('tab3d').classList.toggle('on', t === '3d');
  if (t === '2d') render2d();
}
$('tab2d').onclick = () => setTab('2d');
$('tab3d').onclick = () => setTab('3d');
setTab('3d');

$('modeSelect').onclick = () => { state.mode = 'select'; state.pendingLine = null; syncToolbar(); };
$('modeLight').onclick = () => { state.mode = 'light'; syncToolbar(); };
const lightSel = $('lightType');
LIGHTS.forEach(l => { const o = document.createElement('option'); o.value = l.id; o.textContent = l.name; lightSel.appendChild(o); });
lightSel.value = state.lightType;
lightSel.onchange = () => { state.lightType = lightSel.value; };
$('chkCeil').onchange = e => { state.showCeiling = e.target.checked; rebuild3D(); };
$('chkFurn').onchange = e => { state.showFurniture = e.target.checked; rebuild3D(); render2d(); };
$('btnFrame').onclick = () => frameAll();
function syncToolbar() {
  $('modeSelect').classList.toggle('on', state.mode === 'select');
  $('modeLight').classList.toggle('on', state.mode === 'light');
  $('lightType').style.opacity = state.mode === 'light' ? 1 : 0.45;
  $('lightHint').textContent = state.mode === 'light'
    ? (item(state.lightType)?.kind === 'line' ? '천장/바닥을 두 번 클릭 = 라인조명' : '천장/바닥 클릭 = 조명 설치')
    : '';
}
syncToolbar();

document.addEventListener('keydown', e => {
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (state.sel?.kind === 'light') {
      const r = room(state.sel.roomId);
      if (r && document.activeElement?.tagName !== 'INPUT') { clearHighlight(); removeLight(r, state.sel.lightId); }
    }
  }
  if (e.key === 'Escape') { state.pendingLine = null; state.mode = 'select'; syncToolbar(); }
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
    d.innerHTML = `<div class="rc-top"><b>${r.name}</b><span>${m.area.toFixed(1)}㎡ · ${m.pyeong.toFixed(1)}평</span></div>
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
function sel(label, options, value, onchange) {
  const w = document.createElement('label');
  w.className = 'fld';
  const s = document.createElement('select');
  for (const o of options) {
    const op = document.createElement('option');
    op.value = o.id; op.textContent = `${o.name} (${KRW(o.rate)}원/${o.unit === 'm2' ? '㎡' : o.unit === 'm' ? 'm' : '개'})`;
    s.appendChild(op);
  }
  s.value = value || options[0].id;
  s.onchange = () => onchange(s.value);
  w.innerHTML = `<span>${label}</span>`;
  w.appendChild(s);
  return w;
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
  if (s?.kind === 'wall' && s.roomId === r.id) {
    const w = wallsOf(r).find(x => x.key === s.wallKey);
    head.innerHTML = `<b>${r.name} · 벽 ${s.wallKey}</b>
      <span>길이 ${w ? w.len.toFixed(2) : '?'}m · 순면적 ${w ? w.netArea.toFixed(1) : '?'}㎡ · 개구부 ${w?.openings.length ?? 0}</span>`;
    el.appendChild(head);
    el.appendChild(sel('이 벽 마감(개별)', [{ id: '', name: '기본과 동일', rate: 0, unit: 'm2' }, ...FINISH_WALL],
      r.wallOverrides[s.wallKey] || '', v => {
        if (v) r.wallOverrides[s.wallKey] = v; else delete r.wallOverrides[s.wallKey];
        emit('project');
      }));
    el.appendChild(sel('벽체 유형', WALL_TYPES, r.wallTypes[s.wallKey] || 'wt_keep', v => {
      if (v === 'wt_keep') delete r.wallTypes[s.wallKey]; else r.wallTypes[s.wallKey] = v;
      emit('project');
    }));
  } else if (s?.kind === 'light' && s.roomId === r.id) {
    const l = r.lights.find(x => x.id === s.lightId);
    const li = l && item(l.type);
    head.innerHTML = `<b>${r.name} · ${li?.name ?? '조명'}</b>
      <span>${li?.kind === 'line' && l.x2 != null ? '길이 ' + Math.hypot(l.x2 - l.x, l.z2 - l.z).toFixed(2) + 'm' : `위치 (${l?.x.toFixed(2)}, ${l?.z.toFixed(2)})`}</span>`;
    el.appendChild(head);
    const b = document.createElement('button');
    b.className = 'btn danger'; b.textContent = '이 조명 삭제 (Del)';
    b.onclick = () => { clearHighlight(); removeLight(r, s.lightId); };
    el.appendChild(b);
  } else {
    head.innerHTML = `<b>${r.name}</b>
      <span>${m.area.toFixed(2)}㎡ · ${m.pyeong.toFixed(1)}평 · CH ${(m.H * 1000) | 0} · 벽 순면적 ${m.wallNet.toFixed(1)}㎡ · 문${m.doors} 창${m.windows}</span>`;
    el.appendChild(head);
    const nameFld = document.createElement('label');
    nameFld.className = 'fld';
    nameFld.innerHTML = `<span>방 이름</span>`;
    const inp = document.createElement('input');
    inp.value = r.name;
    inp.onchange = () => { r.name = inp.value; emit('project'); };
    nameFld.appendChild(inp);
    el.appendChild(nameFld);
    el.appendChild(sel('바닥 마감', FINISH_FLOOR, r.floorFinish, v => { r.floorFinish = v; emit('project'); }));
    el.appendChild(sel('벽 마감(기본)', FINISH_WALL, r.wallFinish, v => { r.wallFinish = v; emit('project'); }));
    el.appendChild(sel('천장 마감', FINISH_CEIL, r.ceilFinish, v => { r.ceilFinish = v; emit('project'); }));
    el.appendChild(sel('천장 유형', CEIL_TYPES, r.ceilingType, v => { r.ceilingType = v; emit('project'); }));
    const tip = document.createElement('div');
    tip.className = 'tip';
    tip.textContent = '3D에서 벽을 클릭하면 벽별 마감·유형(가벽/철거)을 따로 지정할 수 있어요.';
    el.appendChild(tip);
  }
}
