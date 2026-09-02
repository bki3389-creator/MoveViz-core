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
  lightFX: false,     // 3D 실광원 효과(기본 꺼짐 — 재료 확인 모드)
  listeners: new Set(),
};

export function on(fn) { state.listeners.add(fn); }
export function emit(what) { for (const fn of state.listeners) fn(what); }

export function newProject(name = '새 현장') {
  return { version: 1, name, company: '', client: '', vatPct: 10, rates: {}, rooms: [] };
}

/// doors/interior_openings 를 openings 로 합쳐 편집 대상을 단일 배열로.
export function normalizePlan(plan) {
  for (const f of plan.furniture || []) if (f.existing === undefined) f.existing = true;   // 스캔 유래 = 기존 가구
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
    lights: [], extras: [],
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

export function pointInPoly(x, z, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1] + 1e-12) + a[0]) c = !c;
  }
  return c;
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

  const ops = allOpenings(plan).map((op, oi) => ({ op, oi, foreign: false, dPos: { x: 0, z: 0 } }));
  // 공유벽 전파: 조립된 다른 방의 개구부가 이 벽과 같은 세계선상에 있으면 이 벽도 뚫는다
  // (문이 한쪽 벽만 뚫리는 문제 해결 — 렌더는 컷만, 심볼·선택·개수는 소유 방이 담당)
  if (state.project && r.pos) {
    for (const other of state.project.rooms) {
      if (other.id === r.id || !other.pos) continue;
      for (const op of other.plan?.openings || []) {
        ops.push({ op, oi: -1, foreign: true,
                   dPos: { x: other.pos.x - r.pos.x, z: other.pos.z - r.pos.z } });
      }
    }
  }
  for (const wall of walls) {
    for (const { op, oi, foreign, dPos } of ops) {
      if (!op.wall_dir || op.wall_pos == null || !op.span || op.span.length < 2) continue;
      if (op.wall_dir !== wall.dir) continue;
      // foreign 개구부는 상대 방 로컬 좌표 → 이 방 로컬로 변환
      const shift = op.wall_dir === 'z' ? dPos.z : dPos.x;       // 벽 법선축 이동량
      const along = op.wall_dir === 'z' ? dPos.x : dPos.z;       // 벽 진행축 이동량
      const wp = op.wall_pos + (foreign ? shift : 0);
      if (Math.abs(wp - wall.pos) > (foreign ? 0.3 : 0.18)) continue;
      const s0 = op.span[0] + (foreign ? along : 0), s1 = op.span[1] + (foreign ? along : 0);
      const lo = Math.max(Math.min(s0, s1), wall.lo);
      const hi = Math.min(Math.max(s0, s1), wall.hi);
      if (hi - lo < 0.15) continue;
      const isWin = op.type === 'window';
      const h = op.height ?? (isWin ? 1.2 : 2.1);
      if (foreign && wall.openings.some(x => !x.foreign && x.lo < hi && x.hi > lo)) continue;  // 자체 개구부와 겹치면 생략
      wall.openings.push({ type: isWin ? 'window' : 'door', lo, hi, w: hi - lo,
                           h: Math.min(h, H - 0.05), idx: oi, foreign,
                           flip: op.flip, dk: op.dk, dm: op.dm });
    }
    wall.openings.sort((p, q) => p.lo - q.lo);
    wall.grossArea = wall.len * H;
    wall.netArea = Math.max(0, wall.grossArea - wall.openings.reduce((s, o) => s + o.w * o.h, 0));
  }

  // 겹침 벽 시각 중복 제거: 프로젝트에서 나보다 앞선 방의 외곽 벽과 같은 선상(0.25m)·
  // 겹치는 구간은 그 방이 그린다 → 내 벽엔 shared 스팬으로 표시(렌더에서 건너뜀).
  // ⚠️ 수량(도배 순면적)은 방별 그대로 — 시각 전용.
  if (state.project && r.pos) {
    const myIdx = state.project.rooms.findIndex(x => x.id === r.id);
    for (let pi = 0; pi < myIdx; pi++) {
      const other = state.project.rooms[pi];
      if (!other?.pos) continue;
      const obd = other.plan?.boundary || [];
      for (let i = 0; i < obd.length; i++) {
        const a = obd[i], b = obd[(i + 1) % obd.length];
        if (!a || !b || (a[0] === b[0] && a[1] === b[1])) continue;
        const dir = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) ? 'z' : 'x';
        const dx = other.pos.x - r.pos.x, dz = other.pos.z - r.pos.z;
        const pos = dir === 'z' ? (a[1] + b[1]) / 2 + dz : (a[0] + b[0]) / 2 + dx;
        const lo2 = dir === 'z' ? Math.min(a[0], b[0]) + dx : Math.min(a[1], b[1]) + dz;
        const hi2 = dir === 'z' ? Math.max(a[0], b[0]) + dx : Math.max(a[1], b[1]) + dz;
        for (const wall of walls) {
          if (wall.inner || wall.dir !== dir) continue;
          if (Math.abs(wall.pos - pos) > 0.25) continue;
          const l = Math.max(wall.lo, lo2), h = Math.min(wall.hi, hi2);
          if (h - l > 0.05) { (wall.shared || (wall.shared = [])).push({ lo: l, hi: h }); }
        }
      }
    }
    for (const wall of walls) wall.shared?.sort((p, q) => p.lo - q.lo);

    // 외벽/내벽 판정: 벽 구간 바깥쪽 점이 어떤 실 폴리곤 안에도 없으면 외벽(외기 접함).
    // 공유 스팬(다른 방과 맞댐) = 내벽. 인테리어에선 외벽 철거 불가 — UI 경고에 사용.
    const worldPolys = state.project.rooms
      .filter(x => x.pos && x.plan?.boundary?.length >= 3)
      .map(x => x.plan.boundary.map(p2 => [p2[0] + x.pos.x, p2[1] + x.pos.z]));
    for (const wall of walls) {
      if (wall.inner) { wall.isExterior = false; continue; }
      const nx = wall.dir === 'z' ? 0 : 1, nz = wall.dir === 'z' ? 1 : 0;
      const midT = (wall.lo + wall.hi) / 2;
      const mx = wall.dir === 'z' ? midT : wall.pos;
      const mz = wall.dir === 'z' ? wall.pos : midT;
      const inward = pointInPoly(mx + nx * 0.2, mz + nz * 0.2, bd) ? 1 : -1;
      // 공유 스팬 제외 구간들
      const gaps = [];
      let cur = wall.lo;
      for (const sp of wall.shared || []) {
        if (sp.lo > cur + 0.02) gaps.push([cur, sp.lo]);
        cur = Math.max(cur, sp.hi);
      }
      if (cur < wall.hi - 0.02) gaps.push([cur, wall.hi]);
      wall.extSpans = [];
      for (const [glo, ghi] of gaps) {
        const t = (glo + ghi) / 2;
        const px = (wall.dir === 'z' ? t : wall.pos) - nx * inward * 0.3 + r.pos.x;
        const pz = (wall.dir === 'z' ? wall.pos : t) - nz * inward * 0.3 + r.pos.z;
        if (!worldPolys.some(poly => pointInPoly(px, pz, poly))) wall.extSpans.push([glo, ghi]);
      }
      const extLen = wall.extSpans.reduce((s2, sp) => s2 + sp[1] - sp[0], 0);
      wall.isExterior = extLen > wall.len * 0.5;
    }
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
  let doorW = 0, doors = 0, windows = 0, openA = 0, winArea = 0, doorWAll = 0;
  for (const w of outer) for (const o of w.openings) {
    openA += o.w * o.h;
    if (o.type === 'door') doorWAll += o.w;   // 걸레받이 공제: 소유 무관 — 구멍엔 걸레받이 없음
    if (o.foreign) continue;   // 상대 방 소유 — 개수는 그쪽에서
    if (o.type === 'door') { doors++; doorW += o.w; }
    else { windows++; winArea += o.w * o.h; }
  }
  const wallNet = Math.max(0, per * H - openA);
  const bb = bboxOf(plan) || { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
  return {
    area, per, H, wallNet, doors, windows, doorW, winArea,
    baseboard: Math.max(0, per - doorWAll), molding: per,
    w: bb.maxX - bb.minX, d: bb.maxZ - bb.minZ,
    pyeong: area * 0.3025,
  };
}

// 방 배치 오프셋(2D/3D 공용): room.pos(사용자 배치, 저장됨)가 있으면 그걸 쓰고,
// 없으면 X축 나열로 초기화해 pos 에 기록. 방은 드래그로 조립(자석 스냅)한다 —
// 방별 스캔은 좌표계가 제각각이라 세대 조립은 사용자가 배치로 확정.
export function layoutOffsets() {
  const off = {}; let nextX = 0;
  for (const r of state.project?.rooms || []) {
    const bb = bboxOf(r.plan);
    if (!bb) { off[r.id] = { x: 0, z: 0, bb: null }; continue; }
    if (!r.pos || typeof r.pos.x !== 'number') {
      r.pos = { x: nextX - bb.minX, z: -bb.minZ };
    }
    nextX = Math.max(nextX, r.pos.x + bb.maxX + 0.8);
    off[r.id] = { x: r.pos.x, z: r.pos.z, bb };
  }
  return off;
}

/// 방 전체 이동 (2D 드래그) — 월드 delta.
export function moveRoomBy(r, dx, dz) {
  if (!r.pos) layoutOffsets();
  r.pos.x += dx; r.pos.z += dz;
}

/// 드래그 종료 시: 50mm 격자 + 다른 방 외곽에 자석(0.25m) — 변 맞대기·모서리 정렬.
export function snapRoomPos(r) {
  const bb = bboxOf(r.plan); if (!bb || !r.pos) return;
  r.pos.x = Math.round(r.pos.x * 20) / 20;
  r.pos.z = Math.round(r.pos.z * 20) / 20;
  const M = 0.25;
  let bestDX = null, bestDZ = null;
  const myL = r.pos.x + bb.minX, myR = r.pos.x + bb.maxX;
  const myT = r.pos.z + bb.minZ, myB = r.pos.z + bb.maxZ;
  for (const other of state.project?.rooms || []) {
    if (other.id === r.id || !other.pos) continue;
    const ob = bboxOf(other.plan); if (!ob) continue;
    const oL = other.pos.x + ob.minX, oR = other.pos.x + ob.maxX;
    const oT = other.pos.z + ob.minZ, oB = other.pos.z + ob.maxZ;
    // X 후보: 내 좌변↔상대 우변, 내 우변↔상대 좌변, 좌↔좌, 우↔우
    for (const d of [oR - myL, oL - myR, oL - myL, oR - myR]) {
      if (Math.abs(d) < M && (bestDX === null || Math.abs(d) < Math.abs(bestDX))) bestDX = d;
    }
    for (const d of [oB - myT, oT - myB, oT - myT, oB - myB]) {
      if (Math.abs(d) < M && (bestDZ === null || Math.abs(d) < Math.abs(bestDZ))) bestDZ = d;
    }
  }
  if (bestDX !== null) r.pos.x += bestDX;
  if (bestDZ !== null) r.pos.z += bestDZ;
}

/// 전체 자동 정렬(일렬)로 리셋.
export function arrangeRooms() {
  for (const r of state.project?.rooms || []) r.pos = null;
  layoutOffsets();
  emit('project');
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
      if (!r.extras) r.extras = [];
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
               lights: JSON.parse(JSON.stringify(r.lights || [])),
               pos: r.pos ? { ...r.pos } : null });
  if (_hist.length > 30) _hist.shift();
}
export function undo() {
  const h = _hist.pop(); if (!h) return false;
  const r = room(h.roomId); if (!r) return false;
  r.plan = h.plan; r.lights = h.lights;
  if (h.pos) r.pos = { ...h.pos };
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
/// 변이 법선으로 이동할 때, 그 변 구간([lo,hi])에 실린 개구부만 wall_pos 동기화.
/// 같은 선상의 다른 조각(스플릿 결과 등) 개구부를 끌고 가지 않는다(감사 확정 결함).
function syncEdgeOpenings(plan, dir, oldPos, newPos, lo, hi) {
  if (Math.abs(oldPos - newPos) < 1e-9) return;
  for (const op of plan.openings || []) {
    if (op.wall_dir !== dir || op.wall_pos == null || !op.span) continue;
    if (Math.abs(op.wall_pos - oldPos) > 0.09) continue;
    const s0 = Math.min(op.span[0], op.span[1]), s1 = Math.max(op.span[0], op.span[1]);
    if (s1 < lo - 0.05 || s0 > hi + 0.05) continue;
    op.wall_pos = newPos;
  }
}

export function moveWall(r, wallKey, newPos, silent) {
  const np = snap(newPos);
  let m = wallKey.match(/^([xz])(\d+)_(\d+)$/);
  if (m) {
    const arr = m[1] === 'x' ? r.plan.xw : r.plan.zw;
    const w2 = arr[+m[2]];
    if (w2) {
      const old = w2.pos;   // 이동 전 위치 기준으로 동기화(빠른 드래그 이탈 방지)
      w2.pos = np;
      const ts = (w2.segs || []).flat();
      if (ts.length) syncEdgeOpenings(r.plan, m[1], old, np, Math.min(...ts), Math.max(...ts));
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
    const elo = horiz ? Math.min(a[0], b[0]) : Math.min(a[1], b[1]);
    const ehi = horiz ? Math.max(a[0], b[0]) : Math.max(a[1], b[1]);
    if (horiz) { a[1] = np; b[1] = np; } else { a[0] = np; b[0] = np; }
    syncEdgeOpenings(r.plan, horiz ? 'z' : 'x', old, np, elo, ehi);   // 이 변 구간의 개구부만 동반
    syncRoomPolys(r);
    if (!silent) emit('project'); return true;
  }
  return false;
}

/// 방 마감 표시색 — finishColors 오버라이드 우선, 없으면 카탈로그 색은 렌더러가 폴백
export function finishColorOf(r, kind) {   // kind: 'floor'|'wall'|'ceil'
  const v = r?.finishColors?.[kind];
  return typeof v === 'number' ? v : null;
}

/// 조명 배치 그리드 — 실 크기에 따라 간격 자동(목표 1.1m), 셀 중심 정렬. L자는 경계 안쪽만.
export function lightGridOf(r) {
  const bb = bboxOf(r.plan); if (!bb) return [];
  const w = bb.maxX - bb.minX, d = bb.maxZ - bb.minZ;
  const nx = Math.max(1, Math.round(w / 1.1)), nz = Math.max(1, Math.round(d / 1.1));
  const bd = r.plan.boundary || [];
  const pts = [];
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
    const x = bb.minX + w * (i + 0.5) / nx, z = bb.minZ + d * (j + 0.5) / nz;
    if (!bd.length || pointInPoly(x, z, bd)) pts.push([x, z]);
  }
  return pts;
}

/// 벽 분할(원본 미니빔 split 이식): 외곽 변에 점 2개 삽입(클릭점 ±0.45m)
/// → 가운데 조각(b<i+1>)을 선택해 법선으로 드래그하면 단(notch)이 된다.
/// 반환: 가운데 조각 변 인덱스, 실패 시 -1. 분할 뒤 b키 +4 밀림 — wallOverrides/wallTypes 자동 리매핑.
export function splitWall(r, wallKey, t) {
  const m2 = wallKey.match(/^b(\d+)$/); if (!m2) return -1;
  const bd = r.plan.boundary; if (!bd || bd.length < 3) return -1;
  const i = +m2[1];
  const a = bd[i], b = bd[(i + 1) % bd.length]; if (!a || !b) return -1;
  const horiz = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]);
  const lo = horiz ? Math.min(a[0], b[0]) : Math.min(a[1], b[1]);
  const hi = horiz ? Math.max(a[0], b[0]) : Math.max(a[1], b[1]);
  let c0 = snap(Math.max(lo + 0.15, t - 0.45));
  let c1 = snap(Math.min(hi - 0.15, t + 0.45));
  if (c1 - c0 < 0.2) return -1;
  // 절단 창이 문/창 스팬을 관통하지 않게 회피(좌우로 탐색, 못 찾으면 실패)
  const edgePos = horiz ? a[1] : a[0];
  const blocked = (r.plan.openings || [])
    .filter(op => op.wall_dir === (horiz ? 'z' : 'x') && op.span
      && Math.abs((op.wall_pos ?? 1e9) - edgePos) < 0.09)
    .map(op => [Math.min(op.span[0], op.span[1]) - 0.1, Math.max(op.span[0], op.span[1]) + 0.1]);
  const clash = (x0, x1) => blocked.some(([b0, b1]) => x1 > b0 && x0 < b1);
  if (clash(c0, c1)) {
    let found = false;
    for (let d3 = 0.1; d3 <= hi - lo && !found; d3 += 0.1) {
      for (const sg2 of [1, -1]) {
        const t2 = t + sg2 * d3;
        const a0 = snap(Math.max(lo + 0.15, t2 - 0.45)), b0 = snap(Math.min(hi - 0.15, t2 + 0.45));
        if (b0 - a0 < 0.2 || clash(a0, b0)) continue;
        c0 = a0; c1 = b0; found = true; break;
      }
    }
    if (!found) return -1;
  }
  pushHistory(r);
  const fwd = (horiz ? b[0] - a[0] : b[1] - a[1]) >= 0;
  const [t0, t1] = fwd ? [c0, c1] : [c1, c0];
  const mk = tv => horiz ? [tv, a[1]] : [a[0], tv];
  // 원본 미니빔 방식: A—C—C'—D'—D—B (C'=C, D'=D 로 시작) — 가운데 C'—D' 조각을
  // 법선으로 끌면 C—C', D'—D 가 수직 연결 스텁이 되어 단(notch)이 만들어진다.
  bd.splice(i + 1, 0, mk(t0), mk(t0), mk(t1), mk(t1));
  // 삽입 지점 뒤 b키 +4 리매핑 — 벽별 마감/유형 지정이 엉뚱한 벽으로 가지 않게
  for (const dict of [r.wallOverrides, r.wallTypes]) {
    if (!dict) continue;
    const ent = Object.entries(dict).filter(([k2]) => /^b\d+$/.test(k2));
    for (const [k2] of ent) delete dict[k2];
    for (const [k2, v2] of ent) {
      const n2 = Number(k2.slice(1));
      dict[n2 > i ? 'b' + (n2 + 4) : k2] = v2;
    }
  }
  syncRoomPolys(r);
  emit('project');
  return i + 2;
}

/// 선택 벽 끝단 그립: 꼭짓점 이동 — 이웃 변이 수평/수직이면 그 축을 따라와 직교 유지.
export function moveCorner(r, vi, nx2, nz2, silent) {
  const bd = r.plan.boundary; if (!bd || !bd[vi]) return;
  const N = bd.length;
  const p = bd[(vi - 1 + N) % N], c = bd[vi], q = bd[(vi + 1) % N];
  const ox = snap(nx2), oz = snap(nz2);
  const oldCx = c[0], oldCz = c[1];
  // 이웃 판정: 수평/수직 변은 직교 동행 + 그 변 개구부 동기.
  // 0길이 스텁(스플릿 중복점)은 짝으로 함께 이동하고, 그 '너머' 이웃을 한 홉 더 동행(찢김 방지).
  const orthoFollow = (u) => {
    const zx = Math.abs(u[0] - oldCx) < 1e-6, zz = Math.abs(u[1] - oldCz) < 1e-6;
    if (zx && zz) return 'zero';
    if (zz && !zx) {   // 수평 이웃 변 (dir 'z')
      syncEdgeOpenings(r.plan, 'z', oldCz, oz, Math.min(u[0], oldCx), Math.max(u[0], oldCx));
      u[1] = oz; return 'h';
    }
    if (zx && !zz) {   // 수직 이웃 변 (dir 'x')
      syncEdgeOpenings(r.plan, 'x', oldCx, ox, Math.min(u[1], oldCz), Math.max(u[1], oldCz));
      u[0] = ox; return 'v';
    }
    return 'diag';
  };
  if (orthoFollow(p) === 'zero') {
    p[0] = ox; p[1] = oz;
    const pp = bd[(vi - 2 + N) % N];
    if (pp !== c && pp !== q) orthoFollow(pp);
  }
  if (orthoFollow(q) === 'zero') {
    q[0] = ox; q[1] = oz;
    const qq = bd[(vi + 2) % N];
    if (qq !== c && qq !== p) orthoFollow(qq);
  }
  c[0] = ox; c[1] = oz;
  syncRoomPolys(r);
  if (!silent) emit('project');
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
    category, category_ko: nameKo, yaw_deg: 0, existing: false,
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
/// 기존 가구 처리: 'keep'(유지) | 'dispose'(폐기 — 최종 도면·3D·인쇄에서 제외, 반출 톤에 합산)
export function setFurnStatus(r, idx, status) {
  const f = r.plan.furniture[idx]; if (!f) return;
  pushHistory(r);
  if (status === 'keep') delete f.status; else f.status = status;
  emit('project');
}

/// 같은 자리(중심·회전 유지) 다른 가구로 교체 — 기존 가구는 replaced 에 기록되어 반출 무게에 합산
export function replaceFurniture(r, idx, spec) {   // spec: {category, name, w, d, oldKg}
  const f = r.plan.furniture[idx]; if (!f) return;
  pushHistory(r);
  const cs = f.obb || f.polygon; if (!cs || cs.length < 3) return;
  const cx = cs.reduce((a, p) => a + p[0], 0) / cs.length;
  const cz = cs.reduce((a, p) => a + p[1], 0) / cs.length;
  if (f.existing !== false && !f.replaced) {
    f.replaced = { name: f.category_ko || f.category, category: f.category, kg: spec.oldKg || 0 };
  }
  f.category = spec.category; f.category_ko = spec.name;
  delete f.status;
  const yaw = (f.yaw_deg || 0) * Math.PI / 180, ca = Math.cos(yaw), sa = Math.sin(yaw);
  const hw = spec.w / 2, hd = spec.d / 2;
  const obb = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([a, b]) =>
    [cx + a * ca - b * sa, cz + a * sa + b * ca]);
  if (f.obb) f.obb = obb; else f.polygon = obb;
  emit('project');
}

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

// 추가 공사 항목 (창호/문/주방/욕실/전기/설비 … EXTRA_ITEMS)
export function addExtra(r, id, qty) {
  if (!r.extras) r.extras = [];
  const ex = r.extras.find(x => x.id === id);
  if (ex) ex.qty += qty; else r.extras.push({ id, qty });
  emit('project');
}
export function setExtraQty(r, id, qty) {
  if (!r.extras) return;
  if (qty <= 0) r.extras = r.extras.filter(x => x.id !== id);
  else { const ex = r.extras.find(x => x.id === id); if (ex) ex.qty = qty; }
  emit('project');
}

/// 벽의 컷 목록(개구부 + 공유 스팬) — 렌더러 공용. {lo, hi, o?}(개구부) | {lo, hi, shared}
export function wallCuts(wall) {
  return [
    ...wall.openings.map(op => ({ lo: op.lo, hi: op.hi, o: op })),
    ...(wall.shared || []).map(s2 => ({ lo: s2.lo, hi: s2.hi, shared: true })),
  ].sort((p, q) => p.lo - q.lo);
}
/// 컷을 제외한 실체 벽 조각 [lo, hi][]
export function wallSolidPieces(wall) {
  const pieces = [];
  let cursor = wall.lo;
  for (const c of wallCuts(wall)) {
    if (c.lo > cursor + 0.005) pieces.push([cursor, c.lo]);
    cursor = Math.max(cursor, c.hi);
  }
  if (cursor < wall.hi - 0.005) pieces.push([cursor, wall.hi]);
  if (!pieces.length && !wallCuts(wall).length) pieces.push([wall.lo, wall.hi]);
  return pieces;
}

// ── 이식 2: 실(구역) 자동 검출 — blueprint3d 룸 검출의 맨해튼 등가(그리드 분해+플러드필).
// 가벽(xw/zw)이 방을 나누면 구역별 폴리곤·면적을 돌려준다. 표시용(견적은 방 단위 유지).
export function detectRegions(r) {
  const plan = r.plan, bd = plan.boundary || [];
  if (bd.length < 3 || (!plan.xw?.length && !plan.zw?.length)) return [];
  const xs = new Set(), zs = new Set();
  for (const p2 of bd) { xs.add(p2[0]); zs.add(p2[1]); }
  for (const w of plan.xw || []) { xs.add(w.pos); for (const s2 of w.segs || []) { zs.add(s2[0]); zs.add(s2[1]); } }
  for (const w of plan.zw || []) { zs.add(w.pos); for (const s2 of w.segs || []) { xs.add(s2[0]); xs.add(s2[1]); } }
  const X = [...xs].sort((a, b) => a - b), Z = [...zs].sort((a, b) => a - b);
  const nx = X.length - 1, nz = Z.length - 1;
  if (nx < 1 || nz < 1 || nx * nz > 4000) return [];
  // 셀 유효성(방 내부) + 셀 간 벽 차단 여부
  const inside = (i, j) => pointInPoly((X[i] + X[i + 1]) / 2, (Z[j] + Z[j + 1]) / 2, bd);
  const wallBetweenX = (x, z0, z1) =>   // x= 위치 세로벽이 z0~z1 사이를 막는가
    (plan.xw || []).some(w => Math.abs(w.pos - x) < 0.03 &&
      (w.segs || []).some(s2 => Math.min(s2[0], s2[1]) < (z0 + z1) / 2 && Math.max(s2[0], s2[1]) > (z0 + z1) / 2));
  const wallBetweenZ = (z, x0, x1) =>
    (plan.zw || []).some(w => Math.abs(w.pos - z) < 0.03 &&
      (w.segs || []).some(s2 => Math.min(s2[0], s2[1]) < (x0 + x1) / 2 && Math.max(s2[0], s2[1]) > (x0 + x1) / 2));
  const id = Array.from({ length: nx }, () => new Array(nz).fill(-1));
  let regions = 0;
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
    if (id[i][j] !== -1 || !inside(i, j)) continue;
    const stack = [[i, j]];
    id[i][j] = regions;
    while (stack.length) {
      const [a, b] = stack.pop();
      const tryGo = (a2, b2, blocked) => {
        if (a2 < 0 || b2 < 0 || a2 >= nx || b2 >= nz) return;
        if (id[a2][b2] !== -1 || blocked || !inside(a2, b2)) return;
        id[a2][b2] = regions; stack.push([a2, b2]);
      };
      tryGo(a + 1, b, wallBetweenX(X[a + 1], Z[b], Z[b + 1]));
      tryGo(a - 1, b, wallBetweenX(X[a], Z[b], Z[b + 1]));
      tryGo(a, b + 1, wallBetweenZ(Z[b + 1], X[a], X[a + 1]));
      tryGo(a, b - 1, wallBetweenZ(Z[b], X[a], X[a + 1]));
    }
    regions++;
  }
  if (regions < 2) return [];
  const out = [];
  for (let k = 0; k < regions; k++) {
    let area = 0, cx = 0, cz = 0;
    for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) if (id[i][j] === k) {
      const a2 = (X[i + 1] - X[i]) * (Z[j + 1] - Z[j]);
      area += a2;
      cx += (X[i] + X[i + 1]) / 2 * a2; cz += (Z[j] + Z[j + 1]) / 2 * a2;
    }
    if (area > 0.3) out.push({ area, cx: cx / area, cz: cz / area });
  }
  return out.length >= 2 ? out : [];
}

// ── 이식 3: 직교 보정(straighten) — openPlan3D 의 RoomPlan 스캔 직각 스냅.
// 벽 길이 가중 ×4 원형평균으로 지배축을 찾아 전체 회전 → 좌표 10mm 스냅.
export function straightenRoom(r) {
  const bd = r.plan.boundary;
  if (!bd || bd.length < 3) return false;
  pushHistory(r);
  let sx = 0, sy = 0;
  for (let i = 0; i < bd.length; i++) {
    const a = bd[i], b = bd[(i + 1) % bd.length];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 0.05) continue;
    const a4 = 4 * Math.atan2(dz, dx);
    sx += len * Math.cos(a4); sy += len * Math.sin(a4);
  }
  const theta = Math.atan2(sy, sx) / 4;
  const bb = bboxOf(r.plan);
  const cx0 = (bb.minX + bb.maxX) / 2, cz0 = (bb.minZ + bb.maxZ) / 2;
  const c = Math.cos(-theta), sn = Math.sin(-theta);
  const sn10 = v => Math.round(v * 100) / 100;
  const rot = p2 => {
    const dx = p2[0] - cx0, dz = p2[1] - cz0;
    return [sn10(cx0 + dx * c - dz * sn), sn10(cz0 + dx * sn + dz * c)];
  };
  const plan = r.plan;
  plan.boundary = plan.boundary.map(rot);
  // 회전 후 세로/가로벽 재분류가 필요할 만큼 비뚤면 xw/zw 는 pos 만 회전 불가 → 단순 스냅만
  plan.xw.forEach(w => { w.pos = sn10(w.pos); w.segs = w.segs.map(s2 => [sn10(s2[0]), sn10(s2[1])]); });
  plan.zw.forEach(w => { w.pos = sn10(w.pos); w.segs = w.segs.map(s2 => [sn10(s2[0]), sn10(s2[1])]); });
  plan.openings.forEach(op => {
    op.wall_pos = sn10(op.wall_pos ?? 0);
    if (op.span) op.span = op.span.map(sn10);
  });
  plan.furniture.forEach(f => {
    if (f.obb) f.obb = f.obb.map(rot);
    if (f.polygon) f.polygon = f.polygon.map(rot);
  });
  (plan.rooms || []).forEach(rm => {
    if (rm.polygon) { rm.polygon = rm.polygon.map(rot); rm.area_m2 = polyArea(rm.polygon); }
  });
  (r.lights || []).forEach(l => {
    [l.x, l.z] = rot([l.x, l.z]);
    if (l.x2 != null) [l.x2, l.z2] = rot([l.x2, l.z2]);
  });
  emit('project');
  return Math.abs(theta) > 0.002;
}

// ── 문 방향(경첩·스윙) — flip 0:기본 1:스윙반전 2:경첩반대 3:경첩반대+스윙반전 ──
export function doorGeom(w, o, bd) {
  const ux = w.dir === 'z' ? 1 : 0, uz = w.dir === 'z' ? 0 : 1;   // 벽 진행
  const nx = w.dir === 'z' ? 0 : 1, nz = w.dir === 'z' ? 1 : 0;   // 법선
  const flip = o.flip || 0;
  const hingeAtEnd = flip >= 2;
  const ht = hingeAtEnd ? o.hi : o.lo;
  const hx = w.dir === 'z' ? ht : w.pos, hz = w.dir === 'z' ? w.pos : ht;
  const ax = ux * (hingeAtEnd ? -1 : 1), az = uz * (hingeAtEnd ? -1 : 1);  // 경첩→반대 잼
  const k = o.w * 0.55;
  const auto = pointInPoly(hx + (ax + nx) * k * 0.75, hz + (az + nz) * k * 0.75, bd) ? 1 : -1;
  const sgn = flip % 2 ? -auto : auto;   // 기본은 방 안쪽으로, 홀수 flip이면 반전
  return { hx, hz, ax, az, nx, nz, sgn };
}

/// Space — 문 방향 4상태 순환 (opening.flip에 저장, 2D/3D/DXF 공통 반영)
export function flipDoor(r, idx) {
  const o = r?.plan?.openings?.[idx];
  if (!o || o.type === 'window') return;
  pushHistory(r);
  o.flip = ((o.flip || 0) + 1) % 4;
  emit('project');
}
