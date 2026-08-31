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

let _rid = 1;
export function addRoom(plan, name) {
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

  const ops = allOpenings(plan);
  for (const wall of walls) {
    for (const op of ops) {
      if (!op.wall_dir || op.wall_pos == null || !op.span || op.span.length < 2) continue;
      if (op.wall_dir !== wall.dir) continue;
      if (Math.abs(op.wall_pos - wall.pos) > 0.18) continue;
      const lo = Math.max(Math.min(op.span[0], op.span[1]), wall.lo);
      const hi = Math.min(Math.max(op.span[0], op.span[1]), wall.hi);
      if (hi - lo < 0.15) continue;
      const isWin = op.type === 'window';
      const h = op.height ?? (isWin ? 1.2 : 2.1);
      wall.openings.push({ type: isWin ? 'window' : 'door', lo, hi, w: hi - lo, h: Math.min(h, H - 0.05) });
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
on(() => { if (state.project) autosave(); });

// 조명 추가/삭제
let _lid = 1;
export function addLight(r, type, x, z, x2, z2) {
  const l = { id: 'l' + (_lid++) + '_' + Math.random().toString(36).slice(2, 5), type, x, z };
  if (x2 != null) { l.x2 = x2; l.z2 = z2; }
  r.lights.push(l);
  emit('lights');
  return l;
}
export function removeLight(r, lightId) {
  r.lights = r.lights.filter(l => l.id !== lightId);
  if (state.sel?.lightId === lightId) state.sel = null;
  emit('lights');
}
