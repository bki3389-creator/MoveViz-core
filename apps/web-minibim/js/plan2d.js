// plan2d.js — 2D 실측 도면: 보기 + 편집(문/창 추가·슬라이드, 가벽 그리기, 벽 이동, 가구 드래그).
// 인터랙션 수식은 아키톤 FloorPlanEditor에서 이식: 개구부 배치 = snap(t·L − w/2) + 양끝 클램프,
// 슬라이드 = 내적 투영, 벽 드래그 = 법선 방향 이동. 인쇄용 방별 렌더(renderRoomImage) 포함.

import { state, emit, layoutOffsets, wallsOf, wallSolidPieces, metricsOf, detectRegions, room, snap, doorGeom, splitWall, moveCorner,
         addOpening, slideOpening, addInnerWall, moveWall, moveFurniture, pushHistory,
         moveRoomBy, snapRoomPos } from './state.js';
import { item } from './catalog.js';

let cv, ctx, view = { z: 1, px: 0, py: 0 };
let fit = { s: 60, ox: 40, oy: 40 };
let fitDirty = true, fitKey = '';
let drag = null;          // {kind:'pan'|'furn'|'opening'|'wall', ...}
let wallDraw = null;      // 가벽 도구 첫 점 {roomId, x, z}
let hoverWall = null;
let wallCur = null;       // 가벽 미리보기 현재점
function axisLock(st2, x, z) {
  return Math.abs(x - st2.x) >= Math.abs(z - st2.z) ? [x, st2.z] : [st2.x, z];
}     // 문/창 도구 호버 표시

const DARK = {   // (이름 유지 — 인터랙티브 테마. 현재 화이트)
  bg: '#fbfcfd', fill: 'rgba(30,45,65,0.035)', fillSel: 'rgba(21,127,190,0.08)',
  wall: '#26303e', wallSel: '#157fbe', win: '#2f86bd', door: '#7a7468',
  furn: 'rgba(23,150,126,0.08)', furnLine: 'rgba(70,130,120,0.75)', furnSel: '#157fbe',
  light: '#b07d10', name: '#1d2734', nameSel: '#157fbe', sub: '#687382', dim: '#4c586a',
  wallCore: '#f6f3ec',
};
const LIGHT = {
  bg: '#ffffff', fill: 'rgba(0,0,0,0.03)', fillSel: 'rgba(0,0,0,0.03)',
  wall: '#1a1a1a', wallSel: '#1a1a1a', win: '#3a7ca5', door: '#555555',
  furn: 'rgba(60,120,120,0.08)', furnLine: '#7a9a9a', furnSel: '#7a9a9a',
  light: '#b8860b', name: '#111111', nameSel: '#111111', sub: '#555555', dim: '#333333',
  wallCore: '#ffffff',
};

function hexA(c, a) { return `rgba(${(c >> 16) & 255},${(c >> 8) & 255},${c & 255},${a})`; }

export function init2D(canvas) {
  cv = canvas; ctx = cv.getContext('2d');
  cv.addEventListener('wheel', onWheel, { passive: false });
  cv.addEventListener('pointerdown', onDown);
  cv.addEventListener('pointermove', onMove);
  cv.addEventListener('pointerup', onUp);
  cv.addEventListener('dblclick', () => { view = { z: 1, px: 0, py: 0 }; fitDirty = true; render2d(); });
  new ResizeObserver(() => { fitDirty = true; render2d(); }).observe(cv.parentElement);
}

function S() { return fit.s * view.z; }
function toPx(wx, wz) { return [wx * S() + fit.ox + view.px, wz * S() + fit.oy + view.py]; }
function toWorld(px, py) { return [(px - fit.ox - view.px) / S(), (py - fit.oy - view.py) / S()]; }
function evPx(e) {   // CSS px → 캔버스 버퍼 px (크기 불일치 보정)
  const rect = cv.getBoundingClientRect();
  return [(e.clientX - rect.left) * cv.width / rect.width,
          (e.clientY - rect.top) * cv.height / rect.height];
}

function computeFit(offs) {
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
  const offs = layoutOffsets();
  const key = (state.project?.rooms || []).map(x => x.id).join(',');
  if (fitDirty || key !== fitKey) { computeFit(offs); fitKey = key; fitDirty = false; }
  for (const r of state.project.rooms) {
    const off = offs[r.id];
    if (off?.bb) paintRoom(ctx, r, off, (x, z) => toPx(x + off.x, z + off.z), S(), DARK, true);
  }
  // 가벽 그리기 미리보기
  if (wallDraw && state.tool2d === 'wall') {
    const off = offs[wallDraw.roomId];
    if (off) {
      const [x, y] = toPx(wallDraw.x + off.x, wallDraw.z + off.z);
      if (wallCur) {   // 축고정 미리보기 선 + 길이(mm)
        const [ex, ez] = axisLock(wallDraw, wallCur[0], wallCur[1]);
        const [x2, y2] = toPx(ex + off.x, ez + off.z);
        ctx.strokeStyle = '#b07d10'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x2, y2); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = '#b07d10'; ctx.font = '10px sans-serif';
        ctx.fillText(String(Math.round(Math.hypot(ex - wallDraw.x, ez - wallDraw.z) * 1000)), (x + x2) / 2 + 6, (y + y2) / 2 - 6);
      }
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
    const ff = item(r.floorFinish);
    g.fillStyle = ff?.color != null ? hexA(ff.color, 0.28) : th.fill;
    g.fill();
    // 바닥 마감 해칭 (클립 후 작도)
    if (s > 16 && ff) {
      g.save(); g.clip();
      g.strokeStyle = 'rgba(40,50,65,0.13)'; g.lineWidth = 0.75;
      const bbx = { x0: Math.min(...bd.map(q => q[0])), x1: Math.max(...bd.map(q => q[0])),
                    z0: Math.min(...bd.map(q => q[1])), z1: Math.max(...bd.map(q => q[1])) };
      const grid = (dx, dz) => {
        if (dx) for (let x = Math.ceil(bbx.x0 / dx) * dx; x < bbx.x1; x += dx) {
          const a1 = P(x, bbx.z0), b1 = P(x, bbx.z1);
          g.beginPath(); g.moveTo(a1[0], a1[1]); g.lineTo(b1[0], b1[1]); g.stroke();
        }
        if (dz) for (let z = Math.ceil(bbx.z0 / dz) * dz; z < bbx.z1; z += dz) {
          const a1 = P(bbx.x0, z), b1 = P(bbx.x1, z);
          g.beginPath(); g.moveTo(a1[0], a1[1]); g.lineTo(b1[0], b1[1]); g.stroke();
        }
      };
      if (r.floorFinish === 'fl_laminate' || r.floorFinish === 'fl_hardwood') grid(0, 0.15);
      else if (r.floorFinish === 'fl_tile600') grid(0.6, 0.6);
      else if (r.floorFinish === 'fl_tile300') grid(0.3, 0.3);
      g.restore();
      // 클립이 path 를 소모 → 선택 외곽선용으로 재구성
      g.beginPath();
      bd.forEach((q, i) => { const [x, y] = P(q[0], q[1]); i ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.closePath();
    }
    if (selected) {
      g.save(); g.strokeStyle = th.wallSel; g.setLineDash([6, 4]); g.lineWidth = 1.2; g.stroke(); g.restore();
    }
  }

  for (const w of wallsOf(r)) {
    const selWall = sel?.kind === 'wall' && sel.roomId === r.id && sel.wallKey === w.key;
    const hovered = interactive && hoverWall && hoverWall.roomId === r.id && hoverWall.key === w.key;
    const bandM = w.inner ? 0.10 : (w.isExterior ? 0.20 : 0.15);   // 외벽 두껍게(도면 관례)
    const t = Math.max(3, bandM * s);
    const pieces = wallSolidPieces(w);
    g.lineCap = 'butt';
    const halfM = bandM / 2;   // 코너 채움용 반두께(m)
    // 연장 조건: 벽 끝단(코너) 또는 공유벽 스킵 경계(앞 방 벽과 이음새) — 개구부 가장자리는 그대로
    const nearShared = t2 => (w.shared || []).some(sp =>
      Math.abs(t2 - sp.lo) < 0.02 || Math.abs(t2 - sp.hi) < 0.02);
    const ext = pieces.map(([a0, b0]) => [
      (Math.abs(a0 - w.lo) < 1e-9 || nearShared(a0)) ? a0 - halfM : a0,
      (Math.abs(b0 - w.hi) < 1e-9 || nearShared(b0)) ? b0 + halfM : b0,
    ]);
    const strokePieces = (color, width) => {
      g.strokeStyle = color; g.lineWidth = width;
      for (const [a, b] of ext) {
        g.beginPath();
        const p1 = w.dir === 'z' ? P(a, w.pos) : P(w.pos, a);
        const p2 = w.dir === 'z' ? P(b, w.pos) : P(w.pos, b);
        g.moveTo(p1[0], p1[1]); g.lineTo(p2[0], p2[1]); g.stroke();
      }
    };
    strokePieces(selWall ? th.wallSel : (hovered ? '#d99a1b' : th.wall), t);
    if (t >= 5) strokePieces(selWall ? '#cfe8f5' : th.wallCore, Math.max(1, t - 3));   // 이중선 코어
    for (const o of w.openings) {
      if (o.foreign) continue;   // 컷은 위 pieces 에서 반영됨 — 심볼은 소유 방이 그림
      const selOp = sel?.kind === 'opening' && sel.roomId === r.id && sel.openingIdx === o.idx;
      const a = w.dir === 'z' ? P(o.lo, w.pos) : P(w.pos, o.lo);
      const b = w.dir === 'z' ? P(o.hi, w.pos) : P(w.pos, o.hi);
      if (o.type === 'window') {
        g.strokeStyle = selOp ? th.wallSel : th.win; g.lineWidth = selOp ? 1.6 : 1;
        for (const k of [-0.5, 0, 0.5]) {
          const dx = w.dir === 'z' ? 0 : k * t, dy = w.dir === 'z' ? k * t : 0;
          g.beginPath(); g.moveTo(a[0] + dx, a[1] + dy); g.lineTo(b[0] + dx, b[1] + dy); g.stroke();
        }
        // 잼(개구부 양끝 마감선)
        g.strokeStyle = th.wall; g.lineWidth = 1.4;
        for (const pt of [a, b]) {
          g.beginPath();
          if (w.dir === 'z') { g.moveTo(pt[0], pt[1] - t / 2 - 1); g.lineTo(pt[0], pt[1] + t / 2 + 1); }
          else { g.moveTo(pt[0] - t / 2 - 1, pt[1]); g.lineTo(pt[0] + t / 2 + 1, pt[1]); }
          g.stroke();
        }
      } else {
        const dcol = o.dm === 'glass' ? th.win : th.door;   // 유리문은 창호색
        if (o.dk === 'slide') {
          // 미닫이: 호 없이 패널 2장(겹침 반개방) 표기
          const vx = b[0] - a[0], vy = b[1] - a[1];
          const Lp = Math.hypot(vx, vy) || 1;
          const ux2 = vx / Lp, uy2 = vy / Lp, nvx = -uy2, nvy = ux2;
          const th3 = Math.max(2.5, t * 0.4);
          g.strokeStyle = selOp ? th.wallSel : dcol; g.lineWidth = selOp ? 3 : 2.2;
          for (const [f0, f1, sg2] of [[0, 0.55, 1], [0.45, 1, -1]]) {
            g.beginPath();
            g.moveTo(a[0] + ux2 * Lp * f0 + nvx * sg2 * th3 * 0.6, a[1] + uy2 * Lp * f0 + nvy * sg2 * th3 * 0.6);
            g.lineTo(a[0] + ux2 * Lp * f1 + nvx * sg2 * th3 * 0.6, a[1] + uy2 * Lp * f1 + nvy * sg2 * th3 * 0.6);
            g.stroke();
          }
        } else {
          // 여닫이: doorGeom(flip 0~3 — Space로 순환. 경첩 위치·스윙 방향 반영)
          const dg = doorGeom(w, o, plan.boundary || []);
          const A2 = P(dg.hx, dg.hz);
          const J2 = P(dg.hx + dg.ax * o.w, dg.hz + dg.az * o.w);
          const L2 = P(dg.hx + dg.nx * dg.sgn * o.w, dg.hz + dg.nz * dg.sgn * o.w);
          const rpx = Math.hypot(J2[0] - A2[0], J2[1] - A2[1]);
          const angJ = Math.atan2(J2[1] - A2[1], J2[0] - A2[0]);
          const angL = Math.atan2(L2[1] - A2[1], L2[0] - A2[0]);
          g.strokeStyle = selOp ? th.wallSel : dcol; g.lineWidth = selOp ? 2 : 1.4;
          g.beginPath(); g.moveTo(A2[0], A2[1]); g.lineTo(L2[0], L2[1]); g.stroke();
          g.setLineDash([3, 3]); g.lineWidth = 1;
          const ccw = ((angL - angJ + Math.PI * 2) % (Math.PI * 2)) > Math.PI;
          g.beginPath(); g.arc(A2[0], A2[1], rpx, angJ, angL, ccw); g.stroke();
          g.setLineDash([]);
        }
      }
      // 개구부 폭 라벨 (선택 시)
      if (selOp) {
        const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        g.fillStyle = th.wallSel; g.font = 'bold 10px sans-serif'; g.textAlign = 'center';
        g.fillText(`${Math.round(o.w * 1000)}`, mid[0], mid[1] - 8);
      }
    }
  }

  // 선택 벽 끝단 그립 — 꼭짓점 드래그로 코너 조정 (직교 유지)
  if (interactive && sel?.kind === 'wall' && sel.roomId === r.id && /^b\d+$/.test(sel.wallKey)) {
    const vi = Number(sel.wallKey.slice(1));
    const bdv = plan.boundary || [];
    const va = bdv[vi], vb = bdv[(vi + 1) % bdv.length];
    if (va && vb) {
      g.fillStyle = '#157fbe'; g.strokeStyle = '#ffffff'; g.lineWidth = 1.5;
      for (const v of [va, vb]) {
        const [gx, gy] = P(v[0], v[1]);
        g.beginPath(); g.rect(gx - 5, gy - 5, 10, 10); g.fill(); g.stroke();
      }
    }
  }

  if (state.showFurniture || !interactive) {
    (plan.furniture || []).forEach((f, fi) => {
      const disposed = f.status === 'dispose';
      if (disposed && !interactive) return;   // 폐기 — 인쇄/최종 출력에서 제외
      const cs = f.obb || f.polygon || [];
      if (cs.length < 3) return;
      const selF = sel?.kind === 'furniture' && sel.roomId === r.id && sel.furnIdx === fi;
      g.beginPath();
      cs.forEach((p, i) => { const [x, y] = P(p[0], p[1]); i ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.closePath();
      if (!disposed) { g.fillStyle = th.furn; g.fill(); }
      g.strokeStyle = disposed ? '#a7aeb8' : (selF ? th.furnSel : th.furnLine);
      g.lineWidth = selF ? 2 : 1;
      if (selF || disposed) g.setLineDash(disposed ? [4, 3] : [5, 3]);
      g.stroke(); g.setLineDash([]);
      if (s > 26 && (f.category_ko || selF || disposed)) {
        const cx = cs.reduce((a, p) => a + p[0], 0) / cs.length;
        const cz = cs.reduce((a, p) => a + p[1], 0) / cs.length;
        const [x, y] = P(cx, cz);
        g.fillStyle = disposed ? '#a7aeb8' : (selF ? th.furnSel : th.furnLine);
        g.font = `${Math.max(8, Math.min(10, 0.16 * s))}px sans-serif`; g.textAlign = 'center';
        g.fillText((disposed ? '✕ ' : '') + (f.category_ko || '') + (disposed ? ' 폐기' : ''), x, y);
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
      const [x, y] = P(l.x, l.z), rr = Math.min(7, Math.max(3, 0.08 * s));
      g.lineWidth = 1.4;
      g.beginPath(); g.arc(x, y, rr, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.moveTo(x - rr, y); g.lineTo(x + rr, y); g.moveTo(x, y - rr); g.lineTo(x, y + rr); g.stroke();
    }
  }

  const bb = off.bb;
  const pxW2 = (bb.maxX - bb.minX) * s, pxH2 = (bb.maxZ - bb.minZ) * s;
  const [cx, cy] = P((bb.minX + bb.maxX) / 2, (bb.minZ + bb.maxZ) / 2);
  if (Math.min(pxW2, pxH2) > 46) {
    g.textAlign = 'center';
    g.fillStyle = selected ? th.nameSel : th.name;
    g.font = `600 ${Math.max(10, Math.min(13, 0.2 * s))}px sans-serif`;
    g.fillText(r.name, cx, cy - 4);
    if (pxW2 > 130) {
      g.fillStyle = th.sub; g.font = `${Math.max(8, Math.min(10, 0.14 * s))}px sans-serif`;
      const subTxt = pxW2 > 190
        ? `${m.area.toFixed(2)}㎡ · ${m.pyeong.toFixed(1)}평 · CH ${(m.H * 1000) | 0}`
        : `${m.area.toFixed(1)}㎡`;
      g.fillText(subTxt, cx, cy + 12);
      if (pxW2 > 190) {
        g.fillStyle = 'rgba(90,100,115,0.85)'; g.font = '9px sans-serif';
        g.fillText(`${item(r.floorFinish)?.name ?? ''} · ${item(r.wallFinish)?.name ?? ''} · ${item(r.ceilFinish)?.name ?? ''}`, cx, cy + 26);
      }
    }
  }

  // 가벽으로 나뉜 구역 면적 (blueprint3d 룸 검출 이식 — 표시용)
  if (interactive) {
    const regs = detectRegions(r);
    if (regs.length >= 2) {
      g.textAlign = 'center';
      regs.forEach((rg, i2) => {
        const [x, y] = P(rg.cx, rg.cz);
        g.fillStyle = 'rgba(21,127,190,0.75)';
        g.font = '600 10px sans-serif';
        g.fillText(`구역${i2 + 1} · ${rg.area.toFixed(1)}㎡`, x, y + 24);
      });
    }
  }

  // 치수선 — 다른 방과 붙은 변에는 생략(어수선 방지), 반대편이 비어 있으면 그쪽에.
  const mm = v => Math.round(v * 1000).toLocaleString('ko-KR');
  const adj = { L: false, R: false, T: false, B: false };
  if (interactive && off.x != null) {
    const offsAll = layoutOffsets();
    const aL = off.x + bb.minX, aR = off.x + bb.maxX, aT = off.z + bb.minZ, aB = off.z + bb.maxZ;
    for (const other of state.project?.rooms || []) {
      if (other.id === r.id) continue;
      const ob = offsAll[other.id]; if (!ob?.bb) continue;
      const bL = ob.x + ob.bb.minX, bR = ob.x + ob.bb.maxX, bT = ob.z + ob.bb.minZ, bB = ob.z + ob.bb.maxZ;
      const xOv = Math.min(aR, bR) - Math.max(aL, bL) > 0.3;
      const zOv = Math.min(aB, bB) - Math.max(aT, bT) > 0.3;
      if (zOv && Math.abs(bL - aR) < 0.35) adj.R = true;
      if (zOv && Math.abs(bR - aL) < 0.35) adj.L = true;
      if (xOv && Math.abs(bT - aB) < 0.35) adj.B = true;
      if (xOv && Math.abs(bB - aT) < 0.35) adj.T = true;
    }
  }
  // 모든 실이 치수를 갖는다 — 붙은 변이면 반대편, 둘 다 붙었으면 그래도 표기
  if (!adj.B || adj.T) dim(P(bb.minX, bb.maxZ), P(bb.maxX, bb.maxZ), [0, 1], mm(bb.maxX - bb.minX));
  else dim(P(bb.minX, bb.minZ), P(bb.maxX, bb.minZ), [0, -1], mm(bb.maxX - bb.minX));
  if (!adj.L || adj.R) dim(P(bb.minX, bb.minZ), P(bb.minX, bb.maxZ), [-1, 0], mm(bb.maxZ - bb.minZ));
  else dim(P(bb.maxX, bb.minZ), P(bb.maxX, bb.maxZ), [1, 0], mm(bb.maxZ - bb.minZ));

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
  // 선택 벽의 끝단 그립 최우선 (코너 드래그)
  const sg = state.sel;
  if (sg?.kind === 'wall' && /^b\d+$/.test(sg.wallKey)) {
    const rG = (state.project?.rooms || []).find(x => x.id === sg.roomId);
    const oG = rG && offs[rG.id];
    if (oG) {
      const vi = Number(sg.wallKey.slice(1));
      const bdv = rG.plan.boundary || [];
      for (const [vIdx, v] of [[vi, bdv[vi]], [(vi + 1) % bdv.length, bdv[(vi + 1) % bdv.length]]]) {
        if (v && Math.hypot(wx - oG.x - v[0], wz - oG.z - v[1]) < Math.max(tol, 0.14)) {
          return { kind: 'corner', r: rG, vertIdx: vIdx };
        }
      }
    }
  }
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
    // 문 반원(스윙 영역) 안쪽 클릭 = 문 선택 (선택 편의)
    for (const w of walls) {
      for (const op of w.openings) {
        if (op.foreign || op.type === 'window' || op.dk === 'slide') continue;
        const dg = doorGeom(w, op, r.plan.boundary || []);
        if (Math.hypot(lx - dg.hx, lz - dg.hz) > op.w + tol) continue;
        const side = ((lx - dg.hx) * dg.nx + (lz - dg.hz) * dg.nz) * dg.sgn;
        const along = (lx - dg.hx) * dg.ax + (lz - dg.hz) * dg.az;
        if (side > -0.05 && along > -0.05) {
          return { kind: 'opening', r, openingIdx: op.idx, wall: w, t: w.dir === 'z' ? lx : lz };
        }
      }
    }
    for (const w of walls) {
      const t = w.dir === 'z' ? lx : lz;                          // 벽 축상 좌표
      const dist = w.dir === 'z' ? Math.abs(lz - w.pos) : Math.abs(lx - w.pos);
      if (dist > Math.max(tol, 0.12) || t < w.lo - 0.1 || t > w.hi + 0.1) continue;
      for (const op of w.openings) {
        if (op.foreign) continue;
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
        const [ex, ez] = axisLock(wallDraw, snap(lx), snap(lz));   // 수평/수직 축고정
        addInnerWall(hit.r, wallDraw.x, wallDraw.z, ex, ez);
        wallDraw = { roomId: hit.r.id, x: ex, z: ez };   // 연속 그리기(끝점=다음 시작점)
      }
    }
    return;
  }

  if (tool === 'split') {
    if (hit && hit.kind === 'wall' && !hit.wall.inner && /^b\d+$/.test(hit.wall.key)) {
      const mi = splitWall(hit.r, hit.wall.key, hit.t);
      if (mi >= 0) {
        state.selRoom = hit.r.id;
        state.sel = { kind: 'wall', roomId: hit.r.id, wallKey: 'b' + mi };
        state.tool2d = 'select';   // 가운데 조각 선택 → 바로 드래그해 단 내밀기
        emit('tool'); emit('select');
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
  if (hit.kind === 'corner') {
    pushHistory(hit.r);
    drag = { kind: 'corner', r: hit.r, idx: hit.vertIdx, moved: false };
    return;   // 기존 벽 선택 유지
  }
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

  if (!drag) {   // 도구별 커서 + 가벽 미리보기 갱신
    if (tool === 'wall') {
      cv.style.cursor = 'crosshair';
      if (wallDraw) {
        const off2 = layoutOffsets()[wallDraw.roomId];
        if (off2) { wallCur = [snap(wx - off2.x), snap(wz - off2.z)]; render2d(); }
      }
    } else if (tool === 'door' || tool === 'window') {
      cv.style.cursor = 'crosshair';
    } else {
      const h2 = hitAt(wx, wz);
      cv.style.cursor = h2 ? (h2.kind === 'room' ? 'grab' : 'move') : 'default';
    }
  }
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
  } else if (drag.kind === 'corner') {
    moveCorner(drag.r, drag.idx, lx, lz, true);
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

export function cancelWallDraw() { wallDraw = null; wallCur = null; if (cv) cv.style.cursor = 'default'; render2d(); }
