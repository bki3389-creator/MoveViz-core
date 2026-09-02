// dxf.js — 현재 프로젝트 → DXF R12 다운로드. iOS DXFExporter.swift 와 동일 구조
// (AutoCAD COM으로 검증된 포맷). 브라우저엔 CP949 인코더가 없어 텍스트는 ASCII로 —
// 실명은 "R1"식 + 면적, 한글 정식 도면은 iOS 앱/AutoCAD에서. 단위 mm.

import { state, layoutOffsets, wallsOf, metricsOf, bboxOf } from './state.js';

const WALL_T = 0.20, ASCII = s => /^[\x20-\x7e]*$/.test(s) ? s : '';

export function exportDXF() {
  const P = state.project;
  if (!P?.rooms.length) return;
  const head = [], ents = [];
  const g = (c, v) => { head.push(String(c), String(v)); };
  const e = (c, v) => { ents.push(String(c), String(v)); };
  const n = v => (v * 1000).toFixed(1);
  let mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
  const EXT = (x, y) => { mnX = Math.min(mnX, x); mnY = Math.min(mnY, y); mxX = Math.max(mxX, x); mxY = Math.max(mxY, y); };

  const line = (x1, y1, x2, y2, L) => { e(0, 'LINE'); e(8, L); e(10, n(x1)); e(20, n(y1)); e(30, '0'); e(11, n(x2)); e(21, n(y2)); e(31, '0'); EXT(x1, y1); EXT(x2, y2); };
  const poly = (pts, L, closed) => {
    e(0, 'POLYLINE'); e(8, L); e(66, '1'); e(70, closed ? '1' : '0'); e(10, '0'); e(20, '0'); e(30, '0');
    for (const [x, y] of pts) { e(0, 'VERTEX'); e(8, L); e(10, n(x)); e(20, n(y)); e(30, '0'); EXT(x, y); }
    e(0, 'SEQEND'); e(8, L);
  };
  const arc = (cx, cy, r, a0, a1, L) => { e(0, 'ARC'); e(8, L); e(10, n(cx)); e(20, n(cy)); e(30, '0'); e(40, n(r)); e(50, a0.toFixed(2)); e(51, a1.toFixed(2)); };
  const text = (x, y, h, s, L, align = 1, rot = 0) => {
    s = ASCII(s) || s.replace(/[^\x20-\x7e]/g, '');   // 비ASCII 제거
    if (!s) return;
    e(0, 'TEXT'); e(8, L); e(10, n(x)); e(20, n(y)); e(30, '0'); e(40, n(h)); e(1, s);
    if (rot) e(50, rot.toFixed(2));
    e(72, String(align)); e(11, n(x)); e(21, n(y)); e(31, '0'); e(73, '2');
  };
  const offsetPolygon = (pts, d) => {
    const N = pts.length;
    let area2 = 0;
    for (let i = 0; i < N; i++) { const a = pts[i], b = pts[(i + 1) % N]; area2 += a[0] * b[1] - b[0] * a[1]; }
    const sign = area2 > 0 ? -1 : 1;
    const oe = i => {
      const a = pts[i], b = pts[(i + 1) % N];
      const dx = b[0] - a[0], dy = b[1] - a[1], L2 = Math.max(Math.hypot(dx, dy), 1e-9);
      const nx = -dy / L2 * sign, ny = dx / L2 * sign;
      return [[a[0] + nx * d, a[1] + ny * d], [b[0] + nx * d, b[1] + ny * d]];
    };
    const out = [];
    for (let i = 0; i < N; i++) {
      const [p1, p2] = oe((i + N - 1) % N), [p3, p4] = oe(i);
      const d1 = [p2[0] - p1[0], p2[1] - p1[1]], d2 = [p4[0] - p3[0], p4[1] - p3[1]];
      const den = d1[0] * d2[1] - d1[1] * d2[0];
      if (Math.abs(den) < 1e-9) { out.push(p3); continue; }
      const t = ((p3[0] - p1[0]) * d2[1] - (p3[1] - p1[1]) * d2[0]) / den;
      out.push([p1[0] + d1[0] * t, p1[1] + d1[1] * t]);
    }
    return out;
  };

  const offs = layoutOffsets();
  P.rooms.forEach((r, ri) => {
    const bb = bboxOf(r.plan); if (!bb) return;
    const off = offs[r.id];
    const X = x => off.x + x;
    const Yf = z => -(off.z + z);   // 전역 z 뒤집기 — 조립 배치 그대로
    const m = metricsOf(r);
    const bd = r.plan.boundary || [];
    if (bd.length >= 3) {
      const inner = bd.map(p => [X(p[0]), Yf(p[1])]);
      poly(inner, 'A-WALL', true);
      poly(offsetPolygon(inner, WALL_T), 'A-WALL', true);
      const cx = inner.reduce((a, p) => a + p[0], 0) / inner.length;
      const cy = inner.reduce((a, p) => a + p[1], 0) / inner.length;
      text(cx, cy + 0.18, 0.18, 'R' + (ri + 1), 'A-ANNO-TEXT');
      text(cx, cy - 0.1, 0.11, m.area.toFixed(2) + ' m2 (' + m.pyeong.toFixed(1) + 'P)', 'A-AREA');
      text(cx, cy - 0.3, 0.1, Math.round(m.w * 1000) + ' x ' + Math.round(m.d * 1000) + '  CH ' + Math.round(m.H * 1000), 'A-AREA');
    }
    for (const w of wallsOf(r)) {
      if (w.inner) {
        if (w.dir === 'x') line(X(w.pos), Yf(w.lo), X(w.pos), Yf(w.hi), 'A-WALL');
        else line(X(w.lo), Yf(w.pos), X(w.hi), Yf(w.pos), 'A-WALL');
      }
      for (const o of w.openings) {
        if (o.type === 'window') {
          for (const k of [-WALL_T / 2, 0, WALL_T / 2]) {
            if (w.dir === 'x') line(X(w.pos + k), Yf(o.lo), X(w.pos + k), Yf(o.hi), 'A-GLAZ');
            else line(X(o.lo), Yf(w.pos + k), X(o.hi), Yf(w.pos + k), 'A-GLAZ');
          }
        } else {
          if (w.dir === 'x') { const hx = X(w.pos), hy = Yf(o.lo); line(hx, hy, hx + o.w, hy, 'A-DOOR'); arc(hx, hy, o.w, 270, 360, 'A-DOOR'); }
          else { const hx = X(o.lo), hy = Yf(w.pos); line(hx, hy, hx, hy + o.w, 'A-DOOR'); arc(hx, hy, o.w, 0, 90, 'A-DOOR'); }
        }
      }
    }
    for (const f of r.plan.furniture || []) {
      const cs = f.obb || f.polygon || [];
      if (cs.length >= 3) poly(cs.map(p => [X(p[0]), Yf(p[1])]), 'A-FURN', true);
    }
    for (const l of r.lights || []) {
      if (l.x2 != null) line(X(l.x), Yf(l.z), X(l.x2), Yf(l.z2), 'E-LITE');
      else { arc(X(l.x), Yf(l.z), 0.06, 0, 360, 'E-LITE'); line(X(l.x) - 0.08, Yf(l.z), X(l.x) + 0.08, Yf(l.z), 'E-LITE'); }
    }
  });
  if (!isFinite(mnX)) return;
  text(mnX, mnY - 0.6, 0.2, (ASCII(P.name) || 'PlanShot') + '  ' + new Date().toISOString().slice(0, 10) + '  unit mm', 'A-ANNO-TEXT', 0);
  text(mnX, mnY - 0.95, 0.13, 'Approx. as-built scan - verify before construction', 'A-ANNO-TEXT', 0);
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
  const layers = [['0', 7], ['A-WALL', 7], ['A-DOOR', 3], ['A-GLAZ', 4], ['A-FURN', 8], ['A-ANNO-TEXT', 7], ['A-AREA', 2], ['E-LITE', 2]];
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
