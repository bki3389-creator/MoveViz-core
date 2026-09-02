// dxf.js — 현재 프로젝트 → DXF R12 다운로드. **2D 화면과 동일한 도면 문법**:
// 벽 이중선(개구부 컷·코너 연장), 문 스윙(방 안쪽), 창 3선+잼, 실명/면적(한글은 \U+XXXX
// 유니코드 이스케이프 — AutoCAD 2004+ 정상 표시), 붙은 변 치수 생략. 단위 mm.

import { state, layoutOffsets, wallsOf, metricsOf, bboxOf } from './state.js';
import { item } from './catalog.js';

export function exportDXF() {
  const P = state.project;
  if (!P?.rooms.length) return;
  const head = [], ents = [];
  const g = (c, v) => { head.push(String(c), String(v)); };
  const e = (c, v) => { ents.push(String(c), String(v)); };
  const n = v => (v * 1000).toFixed(1);
  let mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
  const EXT = (x, y) => { mnX = Math.min(mnX, x); mnY = Math.min(mnY, y); mxX = Math.max(mxX, x); mxY = Math.max(mxY, y); };
  const uesc = s => [...String(s)].map(ch => {
    const c = ch.codePointAt(0);
    return c > 126 ? '\\U+' + c.toString(16).toUpperCase().padStart(4, '0') : ch;
  }).join('');

  const line = (x1, y1, x2, y2, L) => {
    e(0, 'LINE'); e(8, L);
    e(10, n(x1)); e(20, n(y1)); e(30, '0'); e(11, n(x2)); e(21, n(y2)); e(31, '0');
    EXT(x1, y1); EXT(x2, y2);
  };
  const poly = (pts, L, closed) => {
    e(0, 'POLYLINE'); e(8, L); e(66, '1'); e(70, closed ? '1' : '0'); e(10, '0'); e(20, '0'); e(30, '0');
    for (const [x, y] of pts) { e(0, 'VERTEX'); e(8, L); e(10, n(x)); e(20, n(y)); e(30, '0'); EXT(x, y); }
    e(0, 'SEQEND'); e(8, L);
  };
  const arc = (cx, cy, r, a0, a1, L) => {
    e(0, 'ARC'); e(8, L); e(10, n(cx)); e(20, n(cy)); e(30, '0'); e(40, n(r));
    e(50, a0.toFixed(2)); e(51, a1.toFixed(2));
  };
  const text = (x, y, h, s, L, align = 1) => {
    if (!s) return;
    e(0, 'TEXT'); e(8, L); e(10, n(x)); e(20, n(y)); e(30, '0'); e(40, n(h)); e(1, uesc(s));
    e(72, String(align)); e(11, n(x)); e(21, n(y)); e(31, '0'); e(73, '2');
  };
  const inPoly = (x, z, poly2) => {
    let c = false;
    for (let i = 0, j = poly2.length - 1; i < poly2.length; j = i++) {
      const a = poly2[i], b = poly2[j];
      if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1] + 1e-12) + a[0]) c = !c;
    }
    return c;
  };

  const offs = layoutOffsets();

  // 인접 판정 (치수 생략용)
  const adjOf = r => {
    const off = offs[r.id], bb = off?.bb;
    const A = { L: false, R: false, T: false, B: false };
    if (!bb) return A;
    const aL = off.x + bb.minX, aR = off.x + bb.maxX, aT = off.z + bb.minZ, aB = off.z + bb.maxZ;
    for (const o2 of P.rooms) {
      if (o2.id === r.id) continue;
      const ob = offs[o2.id]; if (!ob?.bb) continue;
      const bL = ob.x + ob.bb.minX, bR = ob.x + ob.bb.maxX, bT = ob.z + ob.bb.minZ, bB = ob.z + ob.bb.maxZ;
      const xOv = Math.min(aR, bR) - Math.max(aL, bL) > 0.3;
      const zOv = Math.min(aB, bB) - Math.max(aT, bT) > 0.3;
      if (zOv && Math.abs(bL - aR) < 0.35) A.R = true;
      if (zOv && Math.abs(bR - aL) < 0.35) A.L = true;
      if (xOv && Math.abs(bT - aB) < 0.35) A.B = true;
      if (xOv && Math.abs(bB - aT) < 0.35) A.T = true;
    }
    return A;
  };

  for (const r of P.rooms) {
    const off = offs[r.id], bb = off?.bb;
    if (!bb) continue;
    const X = x => off.x + x;
    const Y = z => -(off.z + z);            // 전역 z 반전 (조립 배치 그대로, 위=+Y)
    const m = metricsOf(r);
    const bd = r.plan.boundary || [];

    // ── 벽: 2D와 동일 — 개구부 컷 + 코너 연장 + 이중선(±tb/2 오프셋 2줄)
    for (const w of wallsOf(r)) {
      const tb = w.inner ? 0.10 : 0.15, halfM = tb / 2;
      const pieces = [];
      let cursor = w.lo;
      for (const o of w.openings) { if (o.lo > cursor) pieces.push([cursor, o.lo]); cursor = Math.max(cursor, o.hi); }
      if (cursor < w.hi) pieces.push([cursor, w.hi]);
      if (!w.openings.length) { pieces.length = 0; pieces.push([w.lo, w.hi]); }
      for (const [a0, b0] of pieces) {
        const a = Math.abs(a0 - w.lo) < 1e-9 ? a0 - halfM : a0;
        const b = Math.abs(b0 - w.hi) < 1e-9 ? b0 + halfM : b0;
        for (const k of [-halfM, halfM]) {   // 이중선
          if (w.dir === 'z') line(X(a), Y(w.pos + k), X(b), Y(w.pos + k), 'A-WALL');
          else line(X(w.pos + k), Y(a), X(w.pos + k), Y(b), 'A-WALL');
        }
        // 조각 끝 마감선(개구부 가장자리 = 잼)
        for (const [end, isCorner] of [[a, Math.abs(a0 - w.lo) < 1e-9], [b, Math.abs(b0 - w.hi) < 1e-9]]) {
          if (isCorner) continue;
          if (w.dir === 'z') line(X(end), Y(w.pos - halfM), X(end), Y(w.pos + halfM), 'A-WALL');
          else line(X(w.pos - halfM), Y(end), X(w.pos + halfM), Y(end), 'A-WALL');
        }
      }
      // ── 개구부 심볼 (소유 방만)
      for (const o of w.openings) {
        if (o.foreign) continue;
        if (o.type === 'window') {
          for (const k of [-halfM, 0, halfM]) {
            if (w.dir === 'z') line(X(o.lo), Y(w.pos + k), X(o.hi), Y(w.pos + k), 'A-GLAZ');
            else line(X(w.pos + k), Y(o.lo), X(w.pos + k), Y(o.hi), 'A-GLAZ');
          }
        } else {
          // 문: 방 안쪽으로 스윙 (2D와 동일 판정)
          const hx = w.dir === 'z' ? o.lo : w.pos;
          const hz = w.dir === 'z' ? w.pos : o.lo;
          const ax = w.dir === 'z' ? 1 : 0, az = w.dir === 'z' ? 0 : 1;
          const nx = w.dir === 'z' ? 0 : 1, nz = w.dir === 'z' ? 1 : 0;
          const k2 = o.w * 0.42;
          const sgnP = inPoly(hx + (ax + nx) * k2, hz + (az + nz) * k2, bd) ? 1 : -1;
          // 평면 z+ 는 DXF Y− → 화면과 동일 모양이 되도록 Y 반전 반영
          const lx = hx + nx * sgnP * o.w, lz = hz + nz * sgnP * o.w;
          line(X(hx), Y(hz), X(lx), Y(lz), 'A-DOOR');                        // 문짝
          const aStart = Math.atan2(Y(lz) - Y(hz), X(lx) - X(hx)) * 180 / Math.PI;
          const aEnd = Math.atan2(Y(hz + az * 0) - Y(hz), X(hx + ax * o.w) - X(hx)) * 180 / Math.PI;
          const [s0, s1] = ((aEnd - aStart + 360) % 360) <= 180 ? [aStart, aEnd] : [aEnd, aStart];
          arc(X(hx), Y(hz), o.w, s0, s1, 'A-DOOR');
        }
      }
    }

    // ── 실명 + 면적/평/CH + 재료 (한글 \U+ 이스케이프)
    const cX = X((bb.minX + bb.maxX) / 2), cY = Y((bb.minZ + bb.maxZ) / 2);
    text(cX, cY + 0.22, 0.16, r.name, 'A-ANNO-TEXT');
    text(cX, cY - 0.02, 0.10, `${m.area.toFixed(2)}m2 (${m.pyeong.toFixed(1)}평) CH ${Math.round(m.H * 1000)}`, 'A-AREA');
    text(cX, cY - 0.22, 0.09,
         `${item(r.floorFinish)?.name ?? ''}·${item(r.wallFinish)?.name ?? ''}`, 'A-AREA');

    // ── 가구 + 라벨
    for (const f of r.plan.furniture || []) {
      const cs = f.obb || f.polygon || [];
      if (cs.length < 3) continue;
      poly(cs.map(p => [X(p[0]), Y(p[1])]), 'A-FURN', true);
      const fx = cs.reduce((a2, p) => a2 + p[0], 0) / cs.length;
      const fz = cs.reduce((a2, p) => a2 + p[1], 0) / cs.length;
      if (f.category_ko) text(X(fx), Y(fz), 0.08, f.category_ko, 'A-FURN');
    }

    // ── 조명
    for (const l of r.lights || []) {
      if (l.x2 != null) line(X(l.x), Y(l.z), X(l.x2), Y(l.z2), 'E-LITE');
      else {
        arc(X(l.x), Y(l.z), 0.06, 0, 360, 'E-LITE');
        line(X(l.x) - 0.08, Y(l.z), X(l.x) + 0.08, Y(l.z), 'E-LITE');
        line(X(l.x), Y(l.z) - 0.08, X(l.x), Y(l.z) + 0.08, 'E-LITE');
      }
    }

    // ── 치수 (붙은 변 생략 — 2D와 동일 규칙)
    const adj = adjOf(r);
    const dim = (x1, y1, x2, y2, out, label) => {
      const o2 = 0.55;
      const A = [x1 + out[0] * o2, y1 + out[1] * o2], B = [x2 + out[0] * o2, y2 + out[1] * o2];
      line(x1 + out[0] * 0.06, y1 + out[1] * 0.06, A[0] + out[0] * 0.08, A[1] + out[1] * 0.08, 'A-ANNO-DIMS');
      line(x2 + out[0] * 0.06, y2 + out[1] * 0.06, B[0] + out[0] * 0.08, B[1] + out[1] * 0.08, 'A-ANNO-DIMS');
      line(A[0], A[1], B[0], B[1], 'A-ANNO-DIMS');
      for (const p2 of [A, B]) line(p2[0] - 0.05, p2[1] - 0.05, p2[0] + 0.05, p2[1] + 0.05, 'A-ANNO-DIMS');
      text((A[0] + B[0]) / 2 + out[0] * 0.14, (A[1] + B[1]) / 2 + out[1] * 0.14, 0.11, label, 'A-ANNO-DIMS', 1);
    };
    const wmm = Math.round((bb.maxX - bb.minX) * 1000).toLocaleString('en-US');
    const dmm = Math.round((bb.maxZ - bb.minZ) * 1000).toLocaleString('en-US');
    if (!adj.B || adj.T) dim(X(bb.minX), Y(bb.maxZ), X(bb.maxX), Y(bb.maxZ), [0, -1], wmm);
    else dim(X(bb.minX), Y(bb.minZ), X(bb.maxX), Y(bb.minZ), [0, 1], wmm);
    if (!adj.L || adj.R) dim(X(bb.minX), Y(bb.maxZ), X(bb.minX), Y(bb.minZ), [-1, 0], dmm);
    else dim(X(bb.maxX), Y(bb.maxZ), X(bb.maxX), Y(bb.minZ), [1, 0], dmm);
  }

  if (!isFinite(mnX)) return;
  text(mnX + 0.2, mnY - 0.6, 0.2, `${P.name || 'PlanShot'}  ${P.company || ''}  단위 mm`, 'A-ANNO-TEXT', 0);
  text(mnX + 0.2, mnY - 0.95, 0.12, '개략 실측 — 시공 발주 전 정밀실측 필요 / iPhone LiDAR', 'A-ANNO-TEXT', 0);
  EXT(mnX, mnY - 1.1);

  g(0, 'SECTION'); g(2, 'HEADER');
  g(9, '$ACADVER'); g(1, 'AC1009');
  g(9, '$INSBASE'); g(10, '0'); g(20, '0'); g(30, '0');
  g(9, '$EXTMIN'); g(10, n(mnX)); g(20, n(mnY)); g(30, '0');
  g(9, '$EXTMAX'); g(10, n(mxX)); g(20, n(mxY)); g(30, '0');
  g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'TABLES');
  g(0, 'TABLE'); g(2, 'LTYPE'); g(70, '1');
  g(0, 'LTYPE'); g(2, 'CONTINUOUS'); g(70, '64'); g(3, 'Solid line'); g(72, '65'); g(73, '0'); g(40, '0.0');
  g(0, 'ENDTAB');
  const layers = [['0', 7], ['A-WALL', 7], ['A-DOOR', 3], ['A-GLAZ', 4], ['A-FURN', 8],
                  ['A-ANNO-TEXT', 7], ['A-AREA', 2], ['A-ANNO-DIMS', 1], ['E-LITE', 2]];
  g(0, 'TABLE'); g(2, 'LAYER'); g(70, String(layers.length));
  for (const [nm, c] of layers) { g(0, 'LAYER'); g(2, nm); g(70, '64'); g(62, String(c)); g(6, 'CONTINUOUS'); }
  g(0, 'ENDTAB');
  g(0, 'TABLE'); g(2, 'STYLE'); g(70, '1');
  g(0, 'STYLE'); g(2, 'STANDARD'); g(70, '0'); g(40, '0.0'); g(41, '1.0'); g(50, '0.0'); g(71, '0'); g(42, '2.5'); g(3, 'txt'); g(4, '');
  g(0, 'ENDTAB'); g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'BLOCKS'); g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'ENTITIES');
  const all = [...head, ...ents, '0', 'ENDSEC', '0', 'EOF'];
  const blob = new Blob([all.join('\r\n') + '\r\n'], { type: 'application/dxf' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (P.name || 'minibim') + '_plan.dxf';
  a.click();
  URL.revokeObjectURL(a.href);
}
