// state.js — 프로젝트 모델 + 실측 지오메트리 파생(벽 세그먼트·개구부 매칭·수량) + 저장/불러오기.
// PlanData 스키마는 iOS 앱의 plan.json 과 동일 (boundary/xw/zw/openings/rooms/furniture, m 단위, XZ 평면).

export const state = {
  project: null,          // { version, name, company, client, rooms:[], rates:{}, vatPct }
  selRoom: null,          // room id
  sel: null,              // { kind:'room'|'wall'|'floor'|'ceiling'|'light', roomId, wallKey?, lightId? }
  mode: 'select',         // 'select' | 'light'
  lightType: 'lt_down3',
  pendingLine: null,      // 라인조명 첫 클릭점 {x,z}
  showCeiling: false,
  showFurniture: true,
  listeners: new Set(),
};

export function on(fn) { state.listeners.add(fn); }
export function emit(what) { for (const fn of state.listeners) fn(what); }

export function newProject(name = '새 현장') {
  return { version: 1, name, company: '', client: '', vatPct: 10, rates: {}, rooms: [] };
}

/// doors/interior_openings 를 openings 로 합쳐 편집 대상을 단일 배열로.
export function normalizePlan(plan) {
  const extra = [...(plan.interior_openings || []), ...(plan.doors || [])];
  if (extra.length) {
    plan.openings = [...(plan.openings || []), ...extra.map(o => ({ ...o, type: o.type || 'door' }))];
    plan.interior_openings = []; plan.doors = [];
  }
  if (!plan.openings) plan.openings = [];
  if (!plan.furniture) plan.furniture = [];
  if (!plan.xw) plan.xw = [];
  if (!plan.zw) plan.zw = [];
  return plan;
}

let _rid = 1;
export function addRoom(plan, name) {
  normalizePlan(plan);
  const r0 = null; // (자리 유지)
  const r = {
    id: 'r' + (_rid++) + '_' + Math.random().toString(36).slice(2, 6),
    name: name || (plan.rooms && plan.rooms[0] && plan.rooms[0].name) || ('방' + (state.project.rooms.length + 1)),
    plan,
    floorFinish: 'fl_laminate', wallFinish: 'wl_silk', ceilFinish: 'cl_silk',
    wallOverrides: {}, wallTypes: {}, ceilingType: 'ct_keep',
    lights: [],
  };
  state.project.rooms.push(r);
  state.selRoom = r.id;
  emit('project');
  return r;
}

export function room(id) { return state.project?.rooms.find(r => r.id === id); }
export function selectedRoom() { return room(state.selRoom) || state.project?.rooms[0] || null; }

// ── 지오메트리 파생 ──────────────────────────────────────────────

export function bboxOf(plan) {
  const pts = [];
  if (plan.boundary) pts.push(...plan.boundary);
  for (const r of plan.rooms || []) if (r.polygon) pts.push(...r.polygon);
  for (const w of plan.xw || []) for (const s of w.segs || []) { pts.push([w.pos, s[0]], [w.pos, s[1]]); }
  for (const w of plan.zw || []) for (const s of w.segs || []) { pts.push([s[0], w.pos], [s[1], w.pos]); }
  if (!pts.length) return null;
  const xs = pts.map(p => p[0]), zs = pts.map(p => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
}

export function polyArea(poly) {
  if (!poly || poly.length < 3) return 0;
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}
export function polyPerimeter(poly) {
  if (!poly || poly.length < 2) return 0;
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return s;
}

export function ceilH(plan) {
  const h = (plan.ceil_y ?? 2.4) - (plan.floor_y ?? 0);
  return (h > 1.8 && h < 4.5) ? h : 2.4;
}

function allOpenings(plan) {
  return [...(plan.openings || []), ...(plan.interior_openings || []), ...(plan.doors || [])];
}

// 방의 벽 세그먼트 목록: 외곽 변 + 내부벽. 각 벽에 개구부(문/창) 부착.
// wall = { key, x1,z1,x2,z2, dir:'x'|'z', pos, len, inner, openings:[{type,lo,hi,w,h}] , netArea, grossArea }
export function wallsOf(r) {
  const plan = r.plan, H = ceilH(plan), walls = [];
  const bd = plan.boundary || [];
  for (let i = 0; i < bd.length; i++) {
    const a = bd[i], b = bd[(i + 1) % bd.length];
    if (!a || !b || (a[0] === b[0] && a[1] === b[1])) continue;
    walls.push(mkWall('b' + i, a[0], a[1], b[0], b[1], false));
  }
  (plan.xw || []).forEach((w, wi) => (w.segs || []).forEach((s, si) => {
    if (s.length >= 2) walls.push(mkWall('x' + wi + '_' + si, w.pos, s[0], w.pos, s[1], true));
  }));
  (plan.zw || []).forEach((w, wi) => (w.segs || []).forEach((s, si) => {
    if (s.length >= 2) walls.push(mkWall('z' + wi + '_' + si, s[0], w.pos, s[1], w.pos, true));
  }));

  const ops = allOpenings(plan).map((op, oi) => ({ op, oi }));   // oi = plan.openings 인덱스(정규화 후)
  for (const wall of walls) {
    for (const { op, oi } of ops) {
      if (!op.wall_dir || op.wall_pos == null || !op.span || op.span.length < 2) continue;
      if (op.wall_dir !== wall.dir) continue;
      if (Math.abs(op.wall_pos - wall.pos) > 0.18) continue;
      const lo = Math.max(Math.min(op.span[0], op.span[1]), wall.lo);
      const hi = Math.min(Math.max(op.span[0], op.span[1]), wall.hi);
      if (hi - lo < 0.15) continue;
      const isWin = op.type === 'window';
      const h = op.height ?? (isWin ? 1.2 : 2.1);
      wall.openings.push({ type: isWin ? 'window' : 'door', lo, hi, w: hi - lo, h: Math.min(h, H - 0.05), idx: oi });
    }
    wall.openings.sort((p, q) => p.lo - q.lo);
    wall.grossArea = wall.len * H;
    wall.netArea = Math.max(0, wall.grossArea - wall.openings.reduce((s, o) => s + o.w * o.h, 0));
  }
  return walls;

  function mkWall(key, x1, z1, x2, z2, inner) {
    const dir = Math.abs(x2 - x1) >= Math.abs(z2 - z1) ? 'z' : 'x';   // 'z'=가로벽(z=pos), 'x'=세로벽(x=pos)
    const pos = dir === 'z' ? (z1 + z2) / 2 : (x1 + x2) / 2;
    const lo = dir === 'z' ? Math.min(x1, x2) : Math.min(z1, z2);
    const hi = dir === 'z' ? Math.max(x1, x2) : Math.max(z1, z2);
    return { key, x1, z1, x2, z2, dir, pos, lo, hi, len: Math.hypot(x2 - x1, z2 - z1), inner, openings: [] };
  }
}

// 실측 수량 요약 (견적·표시 공용)
export function metricsOf(r) {
  const plan = r.plan, H = ceilH(plan);
  const polys = (plan.rooms || []).filter(x => x.polygon && x.polygon.length >= 3).map(x => x.polygon);
  const boundary = plan.boundary && plan.boundary.length >= 3 ? plan.boundary : null;
  const area = polys.length ? polys.reduce((s, p) => s + polyArea(p), 0) : (boundary ? polyArea(boundary) : 0);
  const per = boundary ? polyPerimeter(boundary) : polys.reduce((s, p) => s + polyPerimeter(p), 0);
  const walls = wallsOf(r);
  const outer = walls.filter(w => !w.inner);
  let doorW = 0, doors = 0, windows = 0, openA = 0;
  for (const w of outer) for (const o of w.openings) {
    openA += o.w * o.h;
    if (o.type === 'door') { doors++; doorW += o.w; } else windows++;
  }
  const wallNet = Math.max(0, per * H - openA);
  const bb = bboxOf(plan) || { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
  return {
    area, per, H, wallNet, doors, windows, doorW,
    baseboard: Math.max(0, per - doorW), molding: per,
    w: bb.maxX - bb.minX, d: bb.maxZ - bb.minZ,
    pyeong: area * 0.3025,
  };
}

// 방 배치 오프셋(2D/3D 공용): X축으로 나열, 간격 1.5m
export function layoutOffsets() {
  const off = {}; let x = 0;
  for (const r of state.project?.rooms || []) {
    const bb = bboxOf(r.plan);
    if (!bb) { off[r.id] = { x: x, z: 0, bb: null }; continue; }
    off[r.id] = { x: x - bb.minX, z: -bb.minZ, bb };
    x += (bb.maxX - bb.minX) + 1.5;
  }
  return off;
}

// ── 파일 IO ──────────────────────────────────────────────

// PlanData 판별: boundary/xw/zw 가 있으면 방 하나짜리 평면
export function loadJSONText(text, filename) {
  let obj;
  try { obj = JSON.parse(text); } catch { throw new Error('JSON 파싱 실패: ' + filename); }
  if (obj && obj.version && Array.isArray(obj.rooms) && obj.rooms[0]?.plan) {
    // 미니BIM 프로젝트 파일
    obj.rooms.forEach(r => {
      normalizePlan(r.plan);
      if (!r.lights) r.lights = [];
      if (!r.wallOverrides) r.wallOverrides = {};
      if (!r.wallTypes) r.wallTypes = {};
    });
    state.project = obj;
    state.selRoom = obj.rooms[0]?.id || null;
    _rid = obj.rooms.length + 1;
    emit('project');
    return 'project';
  }
  if (obj && (obj.boundary || obj.xw || obj.zw || obj.rooms)) {
    if (!state.project) state.project = newProject();
    const name = (filename || '').replace(/\.json$/i, '').replace(/^plan[_-]?/i, '') || undefined;
    addRoom(obj, obj.rooms?.[0]?.name || name);
    return 'plan';
  }
  throw new Error('알 수 없는 JSON 형식: ' + filename);
}

export function saveProjectFile() {
  const blob = new Blob([JSON.stringify(state.project, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (state.project.name || '미니빔') + '_프로젝트.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

const LS_KEY = 'minibim.project';
export function autosave() { try { localStorage.setItem(LS_KEY, JSON.stringify(state.project)); } catch {} }
export function restore() {
  try {
    const t = localStorage.getItem(LS_KEY);
    if (t) { loadJSONText(t, '자동저장'); return true; }
  } catch {}
  return false;
}
let _saveTimer = null;
on(() => {
  if (!state.project) return;
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(autosave, 400);
});

// 조명 추가/삭제
let _lid = 1;
export function addLight(r, type, x, z, x2, z2) {
  pushHistory(r);
  const l = { id: 'l' + (_lid++) + '_' + Math.random().toString(36).slice(2, 5), type, x, z };
  if (x2 != null) { l.x2 = x2; l.z2 = z2; }
  r.lights.push(l);
  emit('lights');
  return l;
}
export function removeLight(r, lightId) {
  pushHistory(r);
  r.lights = r.lights.filter(l => l.id !== lightId);
  if (state.sel?.lightId === lightId) state.sel = null;
  emit('lights');
}

// ── 편집 연산 (2D 도구·인스펙터에서 호출) ──────────────────────
// 좌표는 전부 방 로컬(m). 저장은 plan JSON을 직접 수정 — 프로젝트 저장 시 그대로 남는다.

const SNAP = 0.05;   // 50mm 스냅
export const snap = v => Math.round(v / SNAP) * SNAP;

// 언두 — 편집 직전 방 스냅샷(딥카피). 드래그는 drag 시작 시 1회 push.
const _hist = [];
export function pushHistory(r) {
  _hist.push({ roomId: r.id, plan: JSON.parse(JSON.stringify(r.plan)),
               lights: JSON.parse(JSON.stringify(r.lights || [])) });
  if (_hist.length > 30) _hist.shift();
}
export function undo() {
  const h = _hist.pop(); if (!h) return false;
  const r = room(h.roomId); if (!r) return false;
  r.plan = h.plan; r.lights = h.lights;
  state.sel = null;
  emit('project');
  return true;
}

/// 벽 위의 파라미터 t(축상 좌표)에 개구부 추가. 기본 폭: 문 0.9 / 창 1.5.
export function addOpening(r, wall, type, t) {
  pushHistory(r);
  const w0 = type === 'window' ? 1.5 : 0.9;
  const width = Math.min(w0, Math.max(0.3, wall.len - 0.2));
  let lo = snap(t - width / 2);
  lo = Math.max(wall.lo + 0.05, Math.min(lo, wall.hi - width - 0.05));
  const op = { type, wall_dir: wall.dir, wall_pos: wall.pos,
               span: [lo, lo + width], width,
               height: type === 'window' ? 1.2 : 2.1 };
  r.plan.openings.push(op);
  emit('project');
  return r.plan.openings.length - 1;
}

export function updateOpening(r, idx, patch) {
  const op = r.plan.openings[idx]; if (!op) return;
  pushHistory(r);
  Object.assign(op, patch);
  if (patch.width != null && op.span) {
    const lo = Math.min(op.span[0], op.span[1]);
    op.span = [lo, lo + patch.width];
  }
  emit('project');
}

/// 개구부를 벽 축 방향으로 이동(중심 t 지정).
export function slideOpening(r, idx, wall, t, silent) {
  const op = r.plan.openings[idx]; if (!op || !op.span) return;
  const width = Math.abs(op.span[1] - op.span[0]);
  let lo = snap(t - width / 2);
  lo = Math.max(wall.lo + 0.02, Math.min(lo, wall.hi - width - 0.02));
  op.span = [lo, lo + width];
  if (!silent) emit('project');
}

export function removeOpening(r, idx) {
  pushHistory(r);
  r.plan.openings.splice(idx, 1);
  if (state.sel?.kind === 'opening') state.sel = null;
  emit('project');
}

/// 내부 가벽 추가 — 축 정렬로 스냅해 xw(세로)/zw(가로)에 넣는다.
export function addInnerWall(r, x1, z1, x2, z2) {
  if (Math.hypot(x2 - x1, z2 - z1) < 0.2) return null;
  pushHistory(r);
  if (Math.abs(x2 - x1) >= Math.abs(z2 - z1)) {
    const z = snap((z1 + z2) / 2);
    r.plan.zw.push({ pos: z, segs: [[snap(Math.min(x1, x2)), snap(Math.max(x1, x2))]], presence: 1, cls: 'added' });
  } else {
    const x = snap((x1 + x2) / 2);
    r.plan.xw.push({ pos: x, segs: [[snap(Math.min(z1, z2)), snap(Math.max(z1, z2))]], presence: 1, cls: 'added' });
  }
  emit('project');
  return true;
}

/// 벽 key('x{i}_{j}'/'z{i}_{j}'/'b{i}') 파싱해 내부벽 삭제.
export function removeInnerWall(r, key) {
  const m = key.match(/^([xz])(\d+)_(\d+)$/); if (!m) return false;
  const arr = m[1] === 'x' ? r.plan.xw : r.plan.zw;
  const w = arr[+m[2]]; if (!w) return false;
  pushHistory(r);
  // 이 벽에 붙은 개구부도 함께 제거 (댕글링 방지 — 아키톤 리뷰에서 배운 함정)
  const pos = w.pos, dir = m[1];
  r.plan.openings = r.plan.openings.filter(op =>
    !(op.wall_dir === dir && Math.abs((op.wall_pos ?? 1e9) - pos) < 0.18));
  w.segs.splice(+m[3], 1);
  if (!w.segs.length) arr.splice(+m[2], 1);
  if (state.sel?.kind === 'wall') state.sel = null;
  emit('project');
  return true;
}

/// 벽 위치 이동: 내부벽 = pos 변경 / 외곽 변 = 그 변의 두 꼭짓점을 법선축으로 이동(직교 평면 유지).
export function moveWall(r, wallKey, newPos, silent) {
  const np = snap(newPos);
  let m = wallKey.match(/^([xz])(\d+)_(\d+)$/);
  if (m) {
    const arr = m[1] === 'x' ? r.plan.xw : r.plan.zw;
    if (arr[+m[2]]) {
      arr[+m[2]].pos = np;
      // 붙은 개구부의 wall_pos 동기화
      r.plan.openings.forEach(op => {
        if (op.wall_dir === m[1] && Math.abs((op.wall_pos ?? 1e9) - (arr[+m[2]]._prev ?? np)) < 0.3) op.wall_pos = np;
      });
      if (!silent) emit('project'); return true;
    }
    return false;
  }
  m = wallKey.match(/^b(\d+)$/);
  if (m) {
    const bd = r.plan.boundary; const i = +m[1];
    const a = bd[i], b = bd[(i + 1) % bd.length];
    if (!a || !b) return false;
    const horiz = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]);
    const old = horiz ? a[1] : a[0];
    if (horiz) { a[1] = np; b[1] = np; } else { a[0] = np; b[0] = np; }
    // 이 변 위 개구부의 wall_pos 동기화
    r.plan.openings.forEach(op => {
      if (op.wall_dir === (horiz ? 'z' : 'x') && Math.abs((op.wall_pos ?? 1e9) - old) < 0.18) op.wall_pos = np;
    });
    syncRoomPolys(r);
    if (!silent) emit('project'); return true;
  }
  return false;
}

/// 레이저 보정(웹판): 바운딩 가로/세로를 목표(m)로 축별 스케일 — plan 좌표를 직접 변환.
export function scaleRoom(r, targetW, targetD) {
  const bb = bboxOf(r.plan); if (!bb) return;
  pushHistory(r);
  const sx = targetW > 0 ? targetW / (bb.maxX - bb.minX) : 1;
  const sz = targetD > 0 ? targetD / (bb.maxZ - bb.minZ) : 1;
  const fx = x => bb.minX + (x - bb.minX) * sx;
  const fz = z => bb.minZ + (z - bb.minZ) * sz;
  const pt = p => [fx(p[0]), fz(p[1])];
  const plan = r.plan;
  if (plan.boundary) plan.boundary = plan.boundary.map(pt);
  plan.xw.forEach(w => { w.pos = fx(w.pos); w.segs = w.segs.map(s2 => [fz(s2[0]), fz(s2[1])]); });
  plan.zw.forEach(w => { w.pos = fz(w.pos); w.segs = w.segs.map(s2 => [fx(s2[0]), fx(s2[1])]); });
  plan.openings.forEach(op => {
    const alongX = op.wall_dir === 'z';
    op.wall_pos = alongX ? fz(op.wall_pos) : fx(op.wall_pos);
    if (op.span) op.span = op.span.map(v => alongX ? fx(v) : fz(v));
    if (op.span) op.width = Math.abs(op.span[1] - op.span[0]);
  });
  plan.furniture.forEach(f => {
    if (f.obb) f.obb = f.obb.map(pt);
    if (f.polygon) f.polygon = f.polygon.map(pt);
  });
  (plan.rooms || []).forEach(rm => { if (rm.polygon) { rm.polygon = rm.polygon.map(pt); rm.area_m2 = polyArea(rm.polygon); } });
  (r.lights || []).forEach(l => { l.x = fx(l.x); l.z = fz(l.z); if (l.x2 != null) { l.x2 = fx(l.x2); l.z2 = fz(l.z2); } });
  emit('project');
}

function syncRoomPolys(r) {
  // 외곽을 편집하면 rooms[0].polygon 도 동기화(면적 재계산)
  if (r.plan.rooms?.length === 1 && r.plan.boundary) {
    r.plan.rooms[0].polygon = r.plan.boundary.map(p => [...p]);
    r.plan.rooms[0].area_m2 = polyArea(r.plan.boundary);
  }
}

// 가구 편집 — 스캔/카탈로그 공통으로 plan.furniture 직접 조작
export function addFurniture(r, category, nameKo, w, d, cx, cz) {
  pushHistory(r);
  const hw = w / 2, hd = d / 2;
  r.plan.furniture.push({
    obb: [[cx - hw, cz - hd], [cx + hw, cz - hd], [cx + hw, cz + hd], [cx - hw, cz + hd]],
    category, category_ko: nameKo, yaw_deg: 0,
  });
  emit('project');
  return r.plan.furniture.length - 1;
}

export function moveFurniture(r, idx, dx, dz) {
  const f = r.plan.furniture[idx]; if (!f) return;
  const mv = p => [p[0] + dx, p[1] + dz];
  if (f.obb) f.obb = f.obb.map(mv);
  if (f.polygon) f.polygon = f.polygon.map(mv);
}

export function rotateFurniture(r, idx) {
  const f = r.plan.furniture[idx]; if (!f) return;
  pushHistory(r);
  const cs = f.obb || f.polygon; if (!cs || cs.length < 3) return;
  const cx = cs.reduce((a, p) => a + p[0], 0) / cs.length;
  const cz = cs.reduce((a, p) => a + p[1], 0) / cs.length;
  const rot = p => [cx - (p[1] - cz), cz + (p[0] - cx)];   // +90°
  if (f.obb) f.obb = f.obb.map(rot);
  if (f.polygon) f.polygon = f.polygon.map(rot);
  f.yaw_deg = ((f.yaw_deg || 0) + 90) % 360;
  emit('project');
}

export function removeFurniture(r, idx) {
  pushHistory(r);
  r.plan.furniture.splice(idx, 1);
  if (state.sel?.kind === 'furniture') state.sel = null;
  emit('project');
}

/// 가구 치수 변경 — 중심과 yaw 유지한 채 obb 재구성.
export function resizeFurniture(r, idx, w, d) {
  const f = r.plan.furniture[idx]; if (!f) return;
  pushHistory(r);
  const cs = f.obb || f.polygon; if (!cs || cs.length < 3) return;
  const cx = cs.reduce((a, p) => a + p[0], 0) / cs.length;
  const cz = cs.reduce((a, p) => a + p[1], 0) / cs.length;
  const yaw = (f.yaw_deg || 0) * Math.PI / 180, ca = Math.cos(yaw), sa = Math.sin(yaw);
  const hw = w / 2, hd = d / 2;
  const obb = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([a, b]) =>
    [cx + a * ca - b * sa, cz + a * sa + b * ca]);
  if (f.obb) f.obb = obb; else f.polygon = obb;
  emit('project');
}
