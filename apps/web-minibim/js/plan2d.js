// plan2d.js — 2D 실측 도면 캔버스: 벽 밴드·문/창·가구·조명·치수·실명. 클릭=방/벽 선택, 휠 줌, 드래그 팬.

import { state, emit, layoutOffsets, wallsOf, metricsOf, ceilH } from './state.js';
import { item } from './catalog.js';

let cv, ctx, view = { z: 1, px: 0, py: 0 };   // z=배율(px/m 보정계수), px/py=팬(px)
let fit = { s: 60, ox: 40, oy: 40 };
let dragging = null;

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

function computeFit() {
  const offs = layoutOffsets();
  let maxX = 1, maxZ = 1;
  for (const r of state.project?.rooms || []) {
    const o = offs[r.id]; if (!o?.bb) continue;
    maxX = Math.max(maxX, o.x + o.bb.maxX);
    maxZ = Math.max(maxZ, o.z + o.bb.maxZ);
  }
  const W = cv.width, H = cv.height, m = 70;
  fit.s = Math.min((W - m * 2) / maxX, (H - m * 2) / maxZ);
  fit.s = Math.max(8, Math.min(fit.s, 140));
  fit.ox = (W - maxX * fit.s) / 2;
  fit.oy = (H - maxZ * fit.s) / 2;
  return offs;
}

export function render2d() {
  if (!cv) return;
  const box = cv.parentElement.getBoundingClientRect();
  cv.width = Math.max(200, box.width); cv.height = Math.max(200, box.height);
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = '#101318'; ctx.fillRect(0, 0, cv.width, cv.height);
  if (!state.project?.rooms.length) {
    ctx.fillStyle = '#5a6472'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('plan.json 을 드래그하거나 [샘플 열기]를 누르세요', cv.width / 2, cv.height / 2);
    return;
  }
  const offs = computeFit();
  for (const r of state.project.rooms) drawRoom(r, offs[r.id]);
}

function drawRoom(r, off) {
  if (!off?.bb) return;
  const s = S(), plan = r.plan;
  const P = (x, z) => toPx(x + off.x, z + off.z);
  const selected = state.selRoom === r.id;
  const m = metricsOf(r);

  // 방 채움
  const bd = plan.boundary || [];
  if (bd.length >= 3) {
    ctx.beginPath();
    bd.forEach((p, i) => { const [x, y] = P(p[0], p[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.closePath();
    ctx.fillStyle = selected ? 'rgba(33,158,217,0.10)' : 'rgba(255,255,255,0.03)';
    ctx.fill();
  }

  // 벽 (개구부 갭 반영)
  const walls = wallsOf(r);
  for (const w of walls) {
    const selWall = state.sel?.kind === 'wall' && state.sel.roomId === r.id && state.sel.wallKey === w.key;
    const t = Math.max(3, (w.inner ? 0.10 : 0.15) * s);
    ctx.lineCap = 'butt';
    // 개구부로 벽을 조각내기
    let cursor = w.lo;
    const pieces = [];
    for (const o of w.openings) { if (o.lo > cursor) pieces.push([cursor, o.lo]); cursor = Math.max(cursor, o.hi); }
    if (cursor < w.hi) pieces.push([cursor, w.hi]);
    if (!w.openings.length) { pieces.length = 0; pieces.push([w.lo, w.hi]); }
    ctx.strokeStyle = selWall ? '#219ed9' : '#e8e4da';
    ctx.lineWidth = t;
    for (const [a, b] of pieces) {
      ctx.beginPath();
      const p1 = w.dir === 'z' ? P(a, w.pos) : P(w.pos, a);
      const p2 = w.dir === 'z' ? P(b, w.pos) : P(w.pos, b);
      ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); ctx.stroke();
    }
    // 개구부 심볼
    for (const o of w.openings) {
      const a = w.dir === 'z' ? P(o.lo, w.pos) : P(w.pos, o.lo);
      const b = w.dir === 'z' ? P(o.hi, w.pos) : P(w.pos, o.hi);
      if (o.type === 'window') {
        ctx.strokeStyle = '#7fc4e8'; ctx.lineWidth = 1;
        for (const k of [-0.5, 0, 0.5]) {
          const dx = w.dir === 'z' ? 0 : k * t, dy = w.dir === 'z' ? k * t : 0;
          ctx.beginPath(); ctx.moveTo(a[0] + dx, a[1] + dy); ctx.lineTo(b[0] + dx, b[1] + dy); ctx.stroke();
        }
      } else {
        const rpx = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
        ctx.strokeStyle = '#c9c2b4'; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(a[0], a[1]);
        ctx.lineTo(a[0] + rpx * Math.cos(ang + Math.PI / 2), a[1] + rpx * Math.sin(ang + Math.PI / 2)); ctx.stroke();
        ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(a[0], a[1], rpx, ang, ang + Math.PI / 2); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  // 가구
  if (state.showFurniture) {
    for (const f of plan.furniture || []) {
      const cs = f.obb || f.polygon || [];
      if (cs.length < 3) continue;
      ctx.beginPath();
      cs.forEach((p, i) => { const [x, y] = P(p[0], p[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.closePath();
      ctx.fillStyle = 'rgba(56,178,172,0.10)'; ctx.fill();
      ctx.strokeStyle = 'rgba(160,200,200,0.7)'; ctx.lineWidth = 1; ctx.stroke();
      if (s > 28 && f.category_ko) {
        const cx = cs.reduce((a, p) => a + p[0], 0) / cs.length, cz = cs.reduce((a, p) => a + p[1], 0) / cs.length;
        const [x, y] = P(cx, cz);
        ctx.fillStyle = '#79b8b3'; ctx.font = `${Math.max(8, 0.16 * s)}px sans-serif`; ctx.textAlign = 'center';
        ctx.fillText(f.category_ko, x, y);
      }
    }
  }

  // 조명 (2D 기호)
  for (const l of r.lights || []) {
    const li = item(l.type); if (!li) continue;
    const sel = state.sel?.kind === 'light' && state.sel.lightId === l.id;
    ctx.strokeStyle = sel ? '#219ed9' : '#e9c46a'; ctx.fillStyle = sel ? '#219ed9' : '#e9c46a';
    if (li.kind === 'line' && l.x2 != null) {
      const a = P(l.x, l.z), b = P(l.x2, l.z2);
      ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    } else {
      const [x, y] = P(l.x, l.z), rr = Math.max(3, 0.08 * s);
      ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x - rr, y); ctx.lineTo(x + rr, y); ctx.moveTo(x, y - rr); ctx.lineTo(x, y + rr); ctx.stroke();
    }
  }

  // 실명 + 면적 + 치수
  const bb = off.bb;
  const [cx, cy] = P((bb.minX + bb.maxX) / 2, (bb.minZ + bb.maxZ) / 2);
  ctx.textAlign = 'center';
  ctx.fillStyle = selected ? '#4fc3f7' : '#d8d3c8';
  ctx.font = `600 ${Math.max(11, 0.22 * s)}px sans-serif`;
  ctx.fillText(r.name, cx, cy - 0.1 * s);
  ctx.fillStyle = '#8b94a3'; ctx.font = `${Math.max(9, 0.15 * s)}px sans-serif`;
  ctx.fillText(`${m.area.toFixed(2)}㎡ · ${m.pyeong.toFixed(1)}평 · CH ${(m.H * 1000) | 0}`, cx, cy + 0.14 * s);

  // 전체 치수 (하단 폭 / 좌측 깊이)
  const mm = v => Math.round(v * 1000).toLocaleString('ko-KR');
  dim(P(bb.minX, bb.maxZ), P(bb.maxX, bb.maxZ), [0, 1], mm(bb.maxX - bb.minX));
  dim(P(bb.minX, bb.minZ), P(bb.minX, bb.maxZ), [-1, 0], mm(bb.maxZ - bb.minZ));

  function dim(a, b, out, label) {
    const o = 26;
    const A = [a[0] + out[0] * o, a[1] + out[1] * o], B = [b[0] + out[0] * o, b[1] + out[1] * o];
    ctx.strokeStyle = 'rgba(200,195,180,0.5)'; ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(a[0] + out[0] * 4, a[1] + out[1] * 4); ctx.lineTo(A[0] + out[0] * 4, A[1] + out[1] * 4);
    ctx.moveTo(b[0] + out[0] * 4, b[1] + out[1] * 4); ctx.lineTo(B[0] + out[0] * 4, B[1] + out[1] * 4);
    ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]);
    ctx.stroke();
    for (const p of [A, B]) {
      ctx.beginPath(); ctx.moveTo(p[0] - 4, p[1] + 4); ctx.lineTo(p[0] + 4, p[1] - 4); ctx.stroke();
    }
    ctx.fillStyle = '#c8c3b4'; ctx.font = '10px sans-serif';
    ctx.fillText(label, (A[0] + B[0]) / 2 + out[0] * 12, (A[1] + B[1]) / 2 + out[1] * 12 + 3);
  }
}

// ── 인터랙션 ─────────────────────────────

function onWheel(e) {
  e.preventDefault();
  const k = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  const rect = cv.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  // 커서 고정 줌
  view.px = mx - (mx - view.px - fit.ox) * k - fit.ox;
  view.py = my - (my - view.py - fit.oy) * k - fit.oy;
  view.z = Math.max(0.3, Math.min(6, view.z * k));
  render2d();
}
function onDown(e) {
  const rect = cv.getBoundingClientRect();
  dragging = { x: e.clientX - rect.left, y: e.clientY - rect.top, px: view.px, py: view.py, moved: false };
  cv.setPointerCapture(e.pointerId);
}
function onMove(e) {
  if (!dragging) return;
  const rect = cv.getBoundingClientRect();
  const dx = (e.clientX - rect.left) - dragging.x, dy = (e.clientY - rect.top) - dragging.y;
  if (Math.hypot(dx, dy) > 4) dragging.moved = true;
  if (dragging.moved) { view.px = dragging.px + dx; view.py = dragging.py + dy; render2d(); }
}
function onUp(e) {
  const wasDrag = dragging?.moved; dragging = null;
  if (wasDrag) return;
  const rect = cv.getBoundingClientRect();
  const [wx, wz] = toWorld(e.clientX - rect.left, e.clientY - rect.top);
  pick(wx, wz);
}

function pick(wx, wz) {
  const offs = layoutOffsets();
  for (const r of state.project?.rooms || []) {
    const o = offs[r.id]; if (!o?.bb) continue;
    const lx = wx - o.x, lz = wz - o.z;
    // 벽 우선 (거리 0.12m)
    for (const w of wallsOf(r)) {
      const d = w.dir === 'z'
        ? (lx >= w.lo - 0.1 && lx <= w.hi + 0.1 ? Math.abs(lz - w.pos) : 99)
        : (lz >= w.lo - 0.1 && lz <= w.hi + 0.1 ? Math.abs(lx - w.pos) : 99);
      if (d < 0.12) {
        state.selRoom = r.id;
        state.sel = { kind: 'wall', roomId: r.id, wallKey: w.key };
        emit('select'); return;
      }
    }
    if (inPoly(lx, lz, r.plan.boundary || [])) {
      state.selRoom = r.id;
      state.sel = { kind: 'room', roomId: r.id };
      emit('select'); return;
    }
  }
  state.sel = null; emit('select');
}

function inPoly(x, z, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1] + 1e-12) + a[0]) c = !c;
  }
  return c;
}
