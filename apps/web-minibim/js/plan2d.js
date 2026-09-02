// plan2d.js — 2D 실측 도면: 보기 + 편집(문/창 추가·슬라이드, 가벽 그리기, 벽 이동, 가구 드래그).
// 인터랙션 수식은 아키톤 FloorPlanEditor에서 이식: 개구부 배치 = snap(t·L − w/2) + 양끝 클램프,
// 슬라이드 = 내적 투영, 벽 드래그 = 법선 방향 이동. 인쇄용 방별 렌더(renderRoomImage) 포함.

import { state, emit, layoutOffsets, wallsOf, metricsOf, room, snap,
         addOpening, slideOpening, addInnerWall, moveWall, moveFurniture, pushHistory,
         moveRoomBy, snapRoomPos } from './state.js';
import { item } from './catalog.js';

let cv, ctx, view = { z: 1, px: 0, py: 0 };
let fit = { s: 60, ox: 40, oy: 40 };
let drag = null;          // {kind:'pan'|'furn'|'opening'|'wall', ...}
let wallDraw = null;      // 가벽 도구 첫 점 {roomId, x, z}
let hoverWall = null;     // 문/창 도구 호버 표시

const DARK = {   // (이름 유지 — 인터랙티브 테마. 현재 화이트)
  bg: '#fbfcfd', fill: 'rgba(30,45,65,0.035)', fillSel: 'rgba(21,127,190,0.08)',
  wall: '#26303e', wallSel: '#157fbe', win: '#2f86bd', door: '#7a7468',
  furn: 'rgba(23,150,126,0.08)', furnLine: 'rgba(70,130,120,0.75)', furnSel: '#157fbe',
  light: '#b07d10', name: '#1d2734', nameSel: '#157fbe', sub: '#687382', dim: '#4c586a',
};
const LIGHT = {
  bg: '#ffffff', fill: 'rgba(0,0,0,0.03)', fillSel: 'rgba(0,0,0,0.03)',
  wall: '#1a1a1a', wallSel: '#1a1a1a', win: '#3a7ca5', door: '#555555',
  furn: 'rgba(60,120,120,0.08)', furnLine: '#7a9a9a', furnSel: '#7a9a9a',
  light: '#b8860b', name: '#111111', nameSel: '#111111', sub: '#555555', dim: '#333333',
};

export function init2D(canvas) {
  cv = canvas; ctx = cv.getContext('2d');
  cv.addEventListener('wheel', onWheel, { passive: false });
  cv.addEventListener('pointerdown', onDown);
  cv.addEventListener('pointermove', onMove);
  cv.addEventListener('pointerup', onUp);
  cv.addEventListener('dblclick', () => { view = { z: 1, px: 0, py: 0 }; render2d(); });
  new ResizeObserver(() => render2d()).observe(cv.parentElement);
}

function S() { return fit.s * view.z; }
function toPx(wx, wz) { return [wx * S() + fit.ox + view.px, wz * S() + fit.oy + view.py]; }
function toWorld(px, py) { return [(px - fit.ox - view.px) / S(), (py - fit.oy - view.py) / S()]; }
function evPx(e) {   // CSS px → 캔버스 버퍼 px (크기 불일치 보정)
  const rect = cv.getBoundingClientRect();
  return [(e.clientX - rect.left) * cv.width / rect.width,
          (e.clientY - rect.top) * cv.height / rect.height];
}

function computeFit() {
  const offs = layoutOffsets();
  let maxX = 1, maxZ = 1;
  for (const r of state.project?.rooms || []) {
    const o = offs[r.id]; if (!o?.bb) continue;
    maxX = Math.max(maxX, o.x + o.bb.maxX);
    maxZ = Math.max(maxZ, o.z + o.bb.maxZ);
  }
  const W = cv.width, H = cv.height, m = 70;
  fit.s = Math.max(8, Math.min(Math.min((W - m * 2) / maxX, (H - m * 2) / maxZ), 140));
  fit.ox = (W - maxX * fit.s) / 2;
  fit.oy = (H - maxZ * fit.s) / 2;
  return offs;
}

export function render2d() {
  if (!cv) return;
  const box = cv.parentElement.getBoundingClientRect();
  cv.width = Math.max(50, box.width); cv.height = Math.max(50, box.height);
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = DARK.bg; ctx.fillRect(0, 0, cv.width, cv.height);
  if (!state.project?.rooms.length) {
    ctx.fillStyle = '#8a94a4'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('plan.json 을 드래그하거나 [샘플 열기]를 누르세요', cv.width / 2, cv.height / 2);
    return;
  }
  const offs = computeFit();
  for (const r of state.project.rooms) {
    const off = offs[r.id];
    if (off?.bb) paintRoom(ctx, r, off, (x, z) => toPx(x + off.x, z + off.z), S(), DARK, true);
  }
  // 가벽 그리기 미리보기
  if (wallDraw && state.tool2d === 'wall') {
    const off = offs[wallDraw.roomId];
    if (off) {
      const [x, y] = toPx(wallDraw.x + off.x, wallDraw.z + off.z);
      ctx.fillStyle = '#b07d10';
      ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
    }
  }
}

/// 인쇄/내보내기용: 방 하나를 흰 배경 캔버스로 렌더 → dataURL.
export function renderRoomImage(r, wpx = 1000, hpx = 720) {
  const c = document.createElement('canvas');
  c.width = wpx; c.height = hpx;
  const c2 = c.getContext('2d');
  c2.fillStyle = '#ffffff'; c2.fillRect(0, 0, wpx, hpx);
  const bb = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const p of r.plan.boundary || []) {
    bb.minX = Math.min(bb.minX, p[0]); bb.maxX = Math.max(bb.maxX, p[0]);
    bb.minZ = Math.min(bb.minZ, p[1]); bb.maxZ = Math.max(bb.maxZ, p[1]);
  }
  if (!isFinite(bb.minX)) return null;
  const m = 80;
  const s = Math.min((wpx - m * 2) / (bb.maxX - bb.minX), (hpx - m * 2) / (bb.maxZ - bb.minZ));
  const ox = (wpx - (bb.maxX - bb.minX) * s) / 2 - bb.minX * s;
  const oy = (hpx - (bb.maxZ - bb.minZ) * s) / 2 - bb.minZ * s;
  paintRoom(c2, r, { bb }, (x, z) => [x * s + ox, z * s + oy], s, LIGHT, false);
  return c.toDataURL('image/png');
}

// ── 렌더 코어 (인터랙티브/인쇄 공용) ─────────────────────────

function paintRoom(g, r, off, P, s, th, interactive) {
  const plan = r.plan;
  const selected = interactive && state.selRoom === r.id;
  const m = metricsOf(r);
  const sel = interactive ? state.sel : null;

  const bd = plan.boundary || [];
  if (bd.length >= 3) {
    g.beginPath();
    bd.forEach((p, i) => { const [x, y] = P(p[0], p[1]); i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.closePath();
    g.fillStyle = selected ? th.fillSel : th.fill;
    g.fill();
  }

  for (const w of wallsOf(r)) {
    const selWall = sel?.kind === 'wall' && sel.roomId === r.id && sel.wallKey === w.key;
    const hovered = interactive && hoverWall && hoverWall.roomId === r.id && hoverWall.key === w.key;
    const t = Math.max(3, (w.inner ? 0.10 : 0.15) * s);
    const pieces = [];
    let cursor = w.lo;
    for (const o of w.openings) { if (o.lo > cursor) pieces.push([cursor, o.lo]); cursor = Math.max(cursor, o.hi); }
    if (cursor < w.hi) pieces.push([cursor, w.hi]);
    if (!w.openings.length) { pieces.length = 0; pieces.push([w.lo, w.hi]); }
    g.strokeStyle = selWall ? th.wallSel : (hovered ? '#d99a1b' : th.wall);
    g.lineWidth = t; g.lineCap = 'butt';
    for (const [a, b] of pieces) {
      g.beginPath();
      const p1 = w.dir === 'z' ? P(a, w.pos) : P(w.pos, a);
      const p2 = w.dir === 'z' ? P(b, w.pos) : P(w.pos, b);
      g.moveTo(p1[0], p1[1]); g.lineTo(p2[0], p2[1]); g.stroke();
    }
    for (const o of w.openings) {
      const selOp = sel?.kind === 'opening' && sel.roomId === r.id && sel.openingIdx === o.idx;
      const a = w.dir === 'z' ? P(o.lo, w.pos) : P(w.pos, o.lo);
      const b = w.dir === 'z' ? P(o.hi, w.pos) : P(w.pos, o.hi);
      if (o.type === 'window') {
        g.strokeStyle = selOp ? th.wallSel : th.win; g.lineWidth = selOp ? 1.6 : 1;
        for (const k of [-0.5, 0, 0.5]) {
          const dx = w.dir === 'z' ? 0 : k * t, dy = w.dir === 'z' ? k * t : 0;
          g.beginPath(); g.moveTo(a[0] + dx, a[1] + dy); g.lineTo(b[0] + dx, b[1] + dy); g.stroke();
        }
      } else {
        const rpx = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
        g.strokeStyle = selOp ? th.wallSel : th.door; g.lineWidth = selOp ? 2 : 1.4;
        g.beginPath(); g.moveTo(a[0], a[1]);
        g.lineTo(a[0] + rpx * Math.cos(ang + Math.PI / 2), a[1] + rpx * Math.sin(ang + Math.PI / 2)); g.stroke();
        g.setLineDash([3, 3]); g.lineWidth = 1;
        g.beginPath(); g.arc(a[0], a[1], rpx, ang, ang + Math.PI / 2); g.stroke();
        g.setLineDash([]);
      }
      // 개구부 폭 라벨 (선택 시)
      if (selOp) {
        const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        g.fillStyle = th.wallSel; g.font = 'bold 10px sans-serif'; g.textAlign = 'center';
        g.fillText(`${Math.round(o.w * 1000)}`, mid[0], mid[1] - 8);
      }
    }
  }

  if (state.showFurniture || !interactive) {
    (plan.furniture || []).forEach((f, fi) => {
      const cs = f.obb || f.polygon || [];
      if (cs.length < 3) return;
      const selF = sel?.kind === 'furniture' && sel.roomId === r.id && sel.furnIdx === fi;
      g.beginPath();
      cs.forEach((p, i) => { const [x, y] = P(p[0], p[1]); i ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.closePath();
      g.fillStyle = th.furn; g.fill();
      g.strokeStyle = selF ? th.furnSel : th.furnLine; g.lineWidth = selF ? 2 : 1;
      if (selF) g.setLineDash([5, 3]);
      g.stroke(); g.setLineDash([]);
      if (s > 26 && (f.category_ko || selF)) {
        const cx = cs.reduce((a, p) => a + p[0], 0) / cs.length;
        const cz = cs.reduce((a, p) => a + p[1], 0) / cs.length;
        const [x, y] = P(cx, cz);
        g.fillStyle = selF ? th.furnSel : th.furnLine;
        g.font = `${Math.max(8, 0.16 * s)}px sans-serif`; g.textAlign = 'center';
        g.fillText(f.category_ko || '', x, y);
      }
    });
  }

  for (const l of r.lights || []) {
    const li = item(l.type); if (!li) continue;
    const selL = sel?.kind === 'light' && sel.lightId === l.id;
    g.strokeStyle = selL ? th.wallSel : th.light; g.fillStyle = g.strokeStyle;
    if (li.kind === 'line' && l.x2 != null) {
      const a = P(l.x, l.z), b = P(l.x2, l.z2);
      g.lineWidth = 3; g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
    } else {
      const [x, y] = P(l.x, l.z), rr = Math.max(3, 0.08 * s);
      g.lineWidth = 1.4;
      g.beginPath(); g.arc(x, y, rr, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.moveTo(x - rr, y); g.lineTo(x + rr, y); g.moveTo(x, y - rr); g.lineTo(x, y + rr); g.stroke();
    }
  }

  const bb = off.bb;
  const [cx, cy] = P((bb.minX + bb.maxX) / 2, (bb.minZ + bb.maxZ) / 2);
  g.textAlign = 'center';
  g.fillStyle = selected ? th.nameSel : th.name;
  g.font = `600 ${Math.max(11, 0.22 * s)}px sans-serif`;
  g.fillText(r.name, cx, cy - 0.1 * s);
  g.fillStyle = th.sub; g.font = `${Math.max(9, 0.15 * s)}px sans-serif`;
  g.fillText(`${m.area.toFixed(2)}㎡ · ${m.pyeong.toFixed(1)}평 · CH ${(m.H * 1000) | 0}`, cx, cy + 0.14 * s);

  const mm = v => Math.round(v * 1000).toLocaleString('ko-KR');
  dim(P(bb.minX, bb.maxZ), P(bb.maxX, bb.maxZ), [0, 1], mm(bb.maxX - bb.minX));
  dim(P(bb.minX, bb.minZ), P(bb.minX, bb.maxZ), [-1, 0], mm(bb.maxZ - bb.minZ));

  function dim(a, b, out, label) {
    const o2 = 26;
    const A = [a[0] + out[0] * o2, a[1] + out[1] * o2], B = [b[0] + out[0] * o2, b[1] + out[1] * o2];
    g.strokeStyle = th.dim; g.globalAlpha = 0.6; g.lineWidth = 0.8;
    g.beginPath();
    g.moveTo(a[0] + out[0] * 4, a[1] + out[1] * 4); g.lineTo(A[0] + out[0] * 4, A[1] + out[1] * 4);
    g.moveTo(b[0] + out[0] * 4, b[1] + out[1] * 4); g.lineTo(B[0] + out[0] * 4, B[1] + out[1] * 4);
    g.moveTo(A[0], A[1]); g.lineTo(B[0], B[1]);
    g.stroke();
    for (const p of [A, B]) {
      g.beginPath(); g.moveTo(p[0] - 4, p[1] + 4); g.lineTo(p[0] + 4, p[1] - 4); g.stroke();
    }
    g.globalAlpha = 1;
    g.fillStyle = th.dim; g.font = '10px sans-serif';
    g.fillText(label, (A[0] + B[0]) / 2 + out[0] * 12, (A[1] + B[1]) / 2 + out[1] * 12 + 3);
  }
}

// ── 히트테스트 (아키톤 우선순위: 조명 > 가구 > 개구부 > 벽 > 방) ─────

function hitAt(wx, wz) {
  const offs = layoutOffsets();
  const tol = 12 / S();   // 화면 12px 허용
  for (const r of state.project?.rooms || []) {
    const o = offs[r.id]; if (!o?.bb) continue;
    const lx = wx - o.x, lz = wz - o.z;
    for (const l of r.lights || []) {
      if (l.x2 != null) {
        if (distToSeg(lx, lz, l.x, l.z, l.x2, l.z2) < tol) return { kind: 'light', r, lightId: l.id };
      } else if (Math.hypot(lx - l.x, lz - l.z) < Math.max(tol, 0.12)) {
        return { kind: 'light', r, lightId: l.id };
      }
    }
    const furn = r.plan.furniture || [];
    for (let fi = furn.length - 1; fi >= 0; fi--) {
      const cs = furn[fi].obb || furn[fi].polygon || [];
      if (cs.length >= 3 && inPoly(lx, lz, cs)) return { kind: 'furniture', r, furnIdx: fi };
    }
    const walls = wallsOf(r);
    for (const w of walls) {
      const t = w.dir === 'z' ? lx : lz;                          // 벽 축상 좌표
      const dist = w.dir === 'z' ? Math.abs(lz - w.pos) : Math.abs(lx - w.pos);
      if (dist > Math.max(tol, 0.12) || t < w.lo - 0.1 || t > w.hi + 0.1) continue;
      for (const op of w.openings) {
        if (t >= op.lo - 0.05 && t <= op.hi + 0.05) {
          return { kind: 'opening', r, openingIdx: op.idx, wall: w, t };
        }
      }
      return { kind: 'wall', r, wall: w, t };
    }
    if (inPoly(lx, lz, r.plan.boundary || [])) return { kind: 'room', r, lx, lz };
  }
  return null;
}

function distToSeg(px, pz, x1, z1, x2, z2) {
  const dx = x2 - x1, dz = z2 - z1;
  const L2 = dx * dx + dz * dz;
  const t = L2 ? Math.max(0, Math.min(1, ((px - x1) * dx + (pz - z1) * dz) / L2)) : 0;
  return Math.hypot(px - (x1 + dx * t), pz - (z1 + dz * t));
}
function inPoly(x, z, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1] + 1e-12) + a[0]) c = !c;
  }
  return c;
}

// ── 인터랙션 ─────────────────────────────

function onWheel(e) {
  e.preventDefault();
  const k = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  const nz = Math.max(0.3, Math.min(6, view.z * k));
  const ek = nz / view.z;                       // 실제 적용 배율 (클램프 드리프트 방지)
  if (ek === 1) return;
  const [mx, my] = evPx(e);
  view.px = mx - (mx - view.px - fit.ox) * ek - fit.ox;
  view.py = my - (my - view.py - fit.oy) * ek - fit.oy;
  view.z = nz;
  render2d();
}

function localOf(r, wx, wz) {
  const off = layoutOffsets()[r.id];
  return [wx - off.x, wz - off.z];
}

function onDown(e) {
  cv.setPointerCapture(e.pointerId);
  const [mx, my] = evPx(e);
  const [wx, wz] = toWorld(mx, my);
  const tool = state.tool2d || 'select';
  const hit = hitAt(wx, wz);

  if (tool === 'door' || tool === 'window') {
    if (hit && (hit.kind === 'wall' || hit.kind === 'opening')) {
      const r = hit.r;
      const idx = addOpening(r, hit.wall || wallsOf(r).find(w => w.openings.some(o => o.idx === hit.openingIdx)), tool, hit.t ?? 0);
      state.selRoom = r.id;
      state.sel = { kind: 'opening', roomId: r.id, openingIdx: idx };
      state.tool2d = 'select';               // 아키톤 방식: 배치 후 선택 도구 복귀
      emit('tool');
    }
    return;
  }
  if (tool === 'wall') {
    if (hit) {
      const [lx, lz] = localOf(hit.r, wx, wz);
      if (!wallDraw || wallDraw.roomId !== hit.r.id) {
        wallDraw = { roomId: hit.r.id, x: snap(lx), z: snap(lz) };
        render2d();
      } else {
        addInnerWall(hit.r, wallDraw.x, wallDraw.z, snap(lx), snap(lz));
        wallDraw = { roomId: hit.r.id, x: snap(lx), z: snap(lz) };   // 연속 그리기(끝점=다음 시작점)
      }
    }
    return;
  }

  // select 도구
  if (!hit) {
    drag = { kind: 'pan', mx, my, px: view.px, py: view.py, moved: false };
    return;
  }
  state.selRoom = hit.r.id;
  if (hit.kind === 'furniture') {
    pushHistory(hit.r);
    const [lx, lz] = localOf(hit.r, wx, wz);
    drag = { kind: 'furn', r: hit.r, idx: hit.furnIdx, lx, lz, moved: false };
    state.sel = { kind: 'furniture', roomId: hit.r.id, furnIdx: hit.furnIdx };
  } else if (hit.kind === 'opening') {
    pushHistory(hit.r);
    drag = { kind: 'opening', r: hit.r, idx: hit.openingIdx, wall: hit.wall, moved: false };
    state.sel = { kind: 'opening', roomId: hit.r.id, openingIdx: hit.openingIdx };
  } else if (hit.kind === 'wall') {
    pushHistory(hit.r);
    drag = { kind: 'wall', r: hit.r, key: hit.wall.key, wall: hit.wall, moved: false };
    state.sel = { kind: 'wall', roomId: hit.r.id, wallKey: hit.wall.key };
  } else if (hit.kind === 'light') {
    state.sel = { kind: 'light', roomId: hit.r.id, lightId: hit.lightId };
    drag = { kind: 'pan', mx, my, px: view.px, py: view.py, moved: false };
  } else {
    // 방 몸체 드래그 = 방 전체 이동 (세대 조립 — 다른 방 모서리에 자석 스냅)
    pushHistory(hit.r);
    state.sel = { kind: 'room', roomId: hit.r.id };
    drag = { kind: 'room', r: hit.r, wx, wz, moved: false };
  }
  emit('select');
}

function onMove(e) {
  const [mx, my] = evPx(e);
  const [wx, wz] = toWorld(mx, my);
  const tool = state.tool2d || 'select';

  if ((tool === 'door' || tool === 'window') && !drag) {
    const hit = hitAt(wx, wz);
    const nh = hit && hit.kind === 'wall' ? { roomId: hit.r.id, key: hit.wall.key } : null;
    if (JSON.stringify(nh) !== JSON.stringify(hoverWall)) { hoverWall = nh; render2d(); }
    return;
  }
  if (!drag) return;

  if (drag.kind === 'pan') {
    const dx = mx - drag.mx, dy = my - drag.my;
    if (Math.hypot(dx, dy) > 4) drag.moved = true;
    if (drag.moved) { view.px = drag.px + dx; view.py = drag.py + dy; render2d(); }
    return;
  }
  drag.moved = true;
  const [lx, lz] = localOf(drag.r, wx, wz);
  if (drag.kind === 'furn') {
    const dxm = lx - drag.lx, dzm = lz - drag.lz;
    moveFurniture(drag.r, drag.idx, dxm, dzm);
    drag.lx = lx; drag.lz = lz;
    render2d();
  } else if (drag.kind === 'opening') {
    const t = drag.wall.dir === 'z' ? lx : lz;
    slideOpening(drag.r, drag.idx, drag.wall, t, true);
    render2d();
  } else if (drag.kind === 'wall') {
    const np = drag.wall.dir === 'z' ? lz : lx;     // 법선 방향으로 이동
    moveWall(drag.r, drag.key, np, true);
    render2d();
  } else if (drag.kind === 'room') {
    moveRoomBy(drag.r, wx - drag.wx, wz - drag.wz);
    drag.wx = wx; drag.wz = wz;
    render2d();
  }
}

function onUp(e) {
  const d = drag; drag = null;
  if (!d) return;
  if (d.kind === 'pan') {
    if (!d.moved) {
      // 빈 곳 클릭 = 선택 해제 (조명/방 클릭은 down에서 처리됨)
      const [mx, my] = evPx(e);
      const hit = hitAt(...toWorld(mx, my));
      if (!hit) { state.sel = null; emit('select'); }
    }
    return;
  }
  if (d.kind === 'room') {
    if (d.moved) { snapRoomPos(d.r); emit('project'); }
    return;
  }
  if (d.kind === 'furn' && d.moved) {
    // 10mm 스냅 마무리
    const f = d.r.plan.furniture[d.idx];
    const cs = f?.obb || f?.polygon;
    if (cs) {
      const cx = cs.reduce((a, p) => a + p[0], 0) / cs.length;
      const cz = cs.reduce((a, p) => a + p[1], 0) / cs.length;
      const ddx = Math.round(cx * 100) / 100 - cx, ddz = Math.round(cz * 100) / 100 - cz;
      moveFurniture(d.r, d.idx, ddx, ddz);
    }
  }
  emit('project');     // 드래그 완료 → 견적·3D 갱신 1회
}

export function cancelWallDraw() { wallDraw = null; render2d(); }
