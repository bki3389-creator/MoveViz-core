// dxf.js — 현재 프로젝트 → DXF R12 다운로드. 2D 화면과 동일한 도면 문법 + **삶것 실무 레이어 체계**
// (Y:2404 한남다원 티하우스 발행본에서 복원: 벽=A-CON(구조)+A-FIN(마감) — A-WALL 안 씀,
//  치수 1-Dim_axis(축)/1-Dim_axis-in(내부), 문자 2-Tx_<mm> (R12 심볼명 규칙: 공백·마침표 금지), 실명 1-SYM_room,
//  가구 A-FUR, 문 A-DOOR-plan, 창 A-WIN-sec, 조명 A-ETC, 서체 DOTUM=HDOTUM.TTF). 단위 mm.

import { state, layoutOffsets, wallsOf, wallCuts, metricsOf, bboxOf, doorGeom } from './state.js';
import { item } from './catalog.js';

/// DXF 문자열 생성 (테스트/재사용용 — 다운로드는 exportDXF)
export function buildDXFString() {
  const P = state.project;
  if (!P?.rooms.length) return null;
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

  const _lineSeen = new Set();   // 완전 동일 LINE(레이어·좌표) 중복 제거 — 치수 체인 공유 스톱 등
  const line = (x1, y1, x2, y2, L) => {
    const p1 = n(x1) + ',' + n(y1), p2 = n(x2) + ',' + n(y2);
    const sig = L + '|' + (p1 < p2 ? p1 + '|' + p2 : p2 + '|' + p1);   // 방향 무관 동일선 판정
    if (_lineSeen.has(sig)) return;
    _lineSeen.add(sig);
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
    e(7, 'DOTUM');
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
      const tb = w.inner ? 0.10 : (w.isExterior ? 0.20 : 0.15), halfM = tb / 2;
      const WL = (!w.inner && w.isExterior) ? 'A-CON' : 'A-FIN';   // 골조/마감 레이어 분리
      const cutsAll = wallCuts(w);
      const sharedAt = t2 => (w.shared || []).some(sp => t2 > sp.lo - 0.02 && t2 < sp.hi + 0.02);
      const pieces = [];
      { let cursor = w.lo;
        for (const c of cutsAll) {
          if (c.lo > cursor + 0.005) pieces.push([cursor, c.lo]);
          cursor = Math.max(cursor, c.hi);
        }
        if (cursor < w.hi - 0.005) pieces.push([cursor, w.hi]);
        if (!pieces.length) pieces.push([w.lo, w.hi]); }   // 위 루프가 비었을 때만 — 중복 드로잉 방지
      for (const [a0, b0] of pieces) {
        const a = Math.abs(a0 - w.lo) < 1e-9 ? a0 - halfM : a0;
        const b = Math.abs(b0 - w.hi) < 1e-9 ? b0 + halfM : b0;
        for (const k of [-halfM, halfM]) {   // 이중선
          if (w.dir === 'z') line(X(a), Y(w.pos + k), X(b), Y(w.pos + k), WL);
          else line(X(w.pos + k), Y(a), X(w.pos + k), Y(b), WL);
        }
        // 조각 끝 마감선 — 코너·공유 경계는 생략(개구부 잼만)
        for (const [end, isCorner] of [[a, Math.abs(a0 - w.lo) < 1e-9], [b, Math.abs(b0 - w.hi) < 1e-9]]) {
          if (isCorner || sharedAt(end)) continue;
          if (w.dir === 'z') line(X(end), Y(w.pos - halfM), X(end), Y(w.pos + halfM), WL);
          else line(X(w.pos - halfM), Y(end), X(w.pos + halfM), Y(end), WL);
        }
      }
      // ── 개구부 심볼 (소유 방만)
      for (const o of w.openings) {
        if (o.foreign) continue;
        if (o.type === 'window') {
          for (const k of [-halfM, 0, halfM]) {
            if (w.dir === 'z') line(X(o.lo), Y(w.pos + k), X(o.hi), Y(w.pos + k), 'A-WIN-sec');
            else line(X(w.pos + k), Y(o.lo), X(w.pos + k), Y(o.hi), 'A-WIN-sec');
          }
        } else {
          const dl = o.dm === 'glass' ? 'A-WIN-sec' : 'A-DOOR-plan';   // 유리문은 창호 레이어
          if (o.dk === 'slide') {
            // 미닫이: 패널 2장(겹침) — 호 없음
            const pw2 = o.w * 0.55, noff = 0.035;
            const seg = (t0p, t1p, k2) => {
              if (w.dir === 'z') line(X(t0p), Y(w.pos + k2), X(t1p), Y(w.pos + k2), dl);
              else line(X(w.pos + k2), Y(t0p), X(w.pos + k2), Y(t1p), dl);
            };
            seg(o.lo, o.lo + pw2, noff); seg(o.hi - pw2, o.hi, -noff);
          } else {
            // 여닫이: 방 안쪽 스윙 (2D와 동일 판정, flip 반영)
            const dg = doorGeom(w, o, bd);
            const hx = dg.hx, hz = dg.hz;
            const ax = dg.ax, az = dg.az, nx = dg.nx, nz = dg.nz;
            const sgnP = dg.sgn;
            const lx = hx + nx * sgnP * o.w, lz = hz + nz * sgnP * o.w;
            line(X(hx), Y(hz), X(lx), Y(lz), dl);                        // 문짝
            const aStart = Math.atan2(Y(lz) - Y(hz), X(lx) - X(hx)) * 180 / Math.PI;
            const aEnd = Math.atan2(Y(hz + az * o.w) - Y(hz), X(hx + ax * o.w) - X(hx)) * 180 / Math.PI;   // az*0 오타 — 세로벽(dir 'x') 호가 0°/0°로 붕괴하던 결함
            const [s0, s1] = ((aEnd - aStart + 360) % 360) <= 180 ? [aStart, aEnd] : [aEnd, aStart];
            arc(X(hx), Y(hz), o.w, s0, s1, dl);
          }
        }
      }
    }

    // ── 실명 + 면적/평/CH + 재료 (한글 \U+ 이스케이프)
    const cX = X((bb.minX + bb.maxX) / 2), cY = Y((bb.minZ + bb.maxZ) / 2);
    text(cX, cY + 0.22, 0.16, r.name, '1-SYM_room');
    text(cX, cY - 0.02, 0.10, `${m.area.toFixed(2)}m2 (${m.pyeong.toFixed(1)}평) CH ${Math.round(m.H * 1000)}`, '2-Tx_1_5');
    text(cX, cY - 0.22, 0.09,
         `${item(r.floorFinish)?.name ?? ''}·${item(r.wallFinish)?.name ?? ''}`, '2-Tx_1_5');

    // ── 가구 + 라벨
    for (const f of r.plan.furniture || []) {
      if (f.status === 'dispose') continue;   // 폐기 — 최종 도면에서 제외
      const cs = f.obb || f.polygon || [];
      if (cs.length < 3) continue;
      poly(cs.map(p => [X(p[0]), Y(p[1])]), 'A-FUR', true);
      const fx = cs.reduce((a2, p) => a2 + p[0], 0) / cs.length;
      const fz = cs.reduce((a2, p) => a2 + p[1], 0) / cs.length;
      if (f.category_ko) text(X(fx), Y(fz), 0.08, f.category_ko, 'A-FUR');
    }

    // ── 조명
    for (const l of r.lights || []) {
      if (l.x2 != null) line(X(l.x), Y(l.z), X(l.x2), Y(l.z2), 'A-ETC');
      else {
        arc(X(l.x), Y(l.z), 0.06, 0, 360, 'A-ETC');
        line(X(l.x) - 0.08, Y(l.z), X(l.x) + 0.08, Y(l.z), 'A-ETC');
        line(X(l.x), Y(l.z) - 0.08, X(l.x), Y(l.z) + 0.08, 'A-ETC');
      }
    }

    // ── 치수: 모든 외곽 변 전장 + 개구부 위치 체인(방 안쪽) — 인테리어 실시도면 문법
    const adj = adjOf(r);
    const dim = (x1, y1, x2, y2, out, label, o2 = 0.55, h2 = 0.11, DL = '1-Dim_axis') => {
      const A = [x1 + out[0] * o2, y1 + out[1] * o2], B = [x2 + out[0] * o2, y2 + out[1] * o2];
      line(x1 + out[0] * 0.06, y1 + out[1] * 0.06, A[0] + out[0] * 0.08, A[1] + out[1] * 0.08, DL);
      line(x2 + out[0] * 0.06, y2 + out[1] * 0.06, B[0] + out[0] * 0.08, B[1] + out[1] * 0.08, DL);
      line(A[0], A[1], B[0], B[1], DL);
      for (const p2 of [A, B]) line(p2[0] - 0.05, p2[1] - 0.05, p2[0] + 0.05, p2[1] + 0.05, DL);
      text((A[0] + B[0]) / 2 + out[0] * 0.14, (A[1] + B[1]) / 2 + out[1] * 0.14, h2, label, DL, 1);
    };
    const mm = v => Math.round(v * 1000).toLocaleString('en-US');
    for (const w of wallsOf(r)) {
      if (w.inner) continue;
      const sharedLen = (w.shared || []).reduce((s2, sp) => s2 + sp.hi - sp.lo, 0);
      const mid = (w.lo + w.hi) / 2;
      // 평면(월드) 기준 바깥 방향 → DXF는 Y 반전
      const outw = w.dir === 'z'
        ? [0, inPoly(mid, w.pos + 0.08, bd) ? -1 : 1]
        : [inPoly(w.pos + 0.08, mid, bd) ? -1 : 1, 0];
      const outD = [outw[0], -outw[1]];
      if (sharedLen < w.len * 0.6) {   // 이웃이 대부분 덮는 변은 그쪽 도면에서
        if (w.dir === 'z') dim(X(w.lo), Y(w.pos), X(w.hi), Y(w.pos), outD, mm(w.len));
        else dim(X(w.pos), Y(w.lo), X(w.pos), Y(w.hi), outD, mm(w.len));
      }
      // 개구부 체인: 벽끝→문/창 양끝→벽끝 (자기 소유만, 방 안쪽 작은 치수)
      const own = w.openings.filter(o3 => !o3.foreign).sort((p2, q2) => p2.lo - q2.lo);
      if (own.length) {
        const st2 = [w.lo, ...own.flatMap(o3 => [o3.lo, o3.hi]), w.hi];
        const inD = [-outD[0], -outD[1]];
        for (let i2 = 0; i2 + 1 < st2.length; i2++) {
          const A2 = st2[i2], B2 = st2[i2 + 1];
          if (B2 - A2 < 0.08) continue;
          if (w.dir === 'z') dim(X(A2), Y(w.pos), X(B2), Y(w.pos), inD, mm(B2 - A2), 0.38, 0.085, '1-Dim_axis-in');
          else dim(X(w.pos), Y(A2), X(w.pos), Y(B2), inD, mm(B2 - A2), 0.38, 0.085, '1-Dim_axis-in');
        }
      }
    }
    // 비정형(L자 등) 방: 전체 폭/깊이를 한 단계 바깥에 추가
    if ((r.plan.boundary || []).length > 4) {
      const wmm = mm(bb.maxX - bb.minX), dmm = mm(bb.maxZ - bb.minZ);
      if (!adj.B || adj.T) dim(X(bb.minX), Y(bb.maxZ), X(bb.maxX), Y(bb.maxZ), [0, -1], wmm, 1.05);
      else dim(X(bb.minX), Y(bb.minZ), X(bb.maxX), Y(bb.minZ), [0, 1], wmm, 1.05);
      if (!adj.L || adj.R) dim(X(bb.minX), Y(bb.maxZ), X(bb.minX), Y(bb.minZ), [-1, 0], dmm, 1.05);
      else dim(X(bb.maxX), Y(bb.maxZ), X(bb.maxX), Y(bb.minZ), [1, 0], dmm, 1.05);
    }
  }

  // ═══ 단면도 세트: 평면 아래에 방별 단면 + 벽-바닥 접합 상세 ═══
  if (isFinite(mnX)) {
    const secBaseY = mnY - 3.6;   // 평면 아래
    let secX = mnX;
    const SLAB = 0.15, EXT_T = 0.2;
    const FLOOR_FIN = { fl_tile600: 0.03, fl_tile300: 0.03, fl_polish: 0.03 };
    for (const r of P.rooms) {
      const bb = bboxOf(r.plan); if (!bb) continue;
      const m = metricsOf(r);
      const W = bb.maxX - bb.minX, H = m.H;
      const ox = secX + EXT_T, oy = secBaseY - H;   // oy = 바닥 마감면
      const finT = FLOOR_FIN[r.floorFinish] ?? 0.012;
      // 바닥: 구조 슬래브 + 마감층
      poly([[ox - EXT_T, oy - finT - SLAB], [ox + W + EXT_T, oy - finT - SLAB],
            [ox + W + EXT_T, oy - finT], [ox - EXT_T, oy - finT]], 'A-CON', true);
      line(ox, oy, ox + W, oy, 'A-FIN');                                  // 바닥 마감면
      line(ox, oy - finT, ox + W, oy - finT, 'A-FIN');                    // 마감층 하단
      // 좌우 벽 골조 + 마감선
      for (const [wx0, sgn2] of [[ox - EXT_T, 1], [ox + W, -1]]) {
        poly([[wx0, oy - finT], [wx0 + EXT_T, oy - finT], [wx0 + EXT_T, oy + H + 0.1], [wx0, oy + H + 0.1]], 'A-CON', true);
        const fx2 = sgn2 > 0 ? wx0 + EXT_T + 0.012 : wx0 - 0.012;
        line(fx2, oy, fx2, oy + H, 'A-FIN');                              // 벽 마감선(도배/타일)
      }
      // 상부 슬래브
      poly([[ox - EXT_T, oy + H + 0.1], [ox + W + EXT_T, oy + H + 0.1],
            [ox + W + EXT_T, oy + H + 0.1 + SLAB], [ox - EXT_T, oy + H + 0.1 + SLAB]], 'A-CON', true);
      // 천장 유형별 프로파일
      const ct2 = r.ceilingType;
      if (ct2 === 'ct_well' && W > 1.4) {
        const bnd = 0.35, drop = 0.12;
        line(ox, oy + H, ox + bnd, oy + H, 'A-FIN');
        line(ox + W - bnd, oy + H, ox + W, oy + H, 'A-FIN');
        line(ox + bnd, oy + H, ox + bnd, oy + H + drop, 'A-FIN');
        line(ox + W - bnd, oy + H, ox + W - bnd, oy + H + drop, 'A-FIN');
        line(ox + bnd, oy + H + drop, ox + W - bnd, oy + H + drop, 'A-FIN');
      } else if (ct2 === 'ct_indirect' && W > 1.0) {
        for (const bx of [ox, ox + W - 0.3]) {
          poly([[bx, oy + H - 0.15], [bx + 0.3, oy + H - 0.15], [bx + 0.3, oy + H], [bx, oy + H]], 'A-FIN', true);
        }
        line(ox + 0.3, oy + H, ox + W - 0.3, oy + H, 'A-FIN');
      } else {
        line(ox, oy + H, ox + W, oy + H, 'A-FIN');                        // 평천장 마감선
      }
      // 치수(CH·폭) + 라벨
      line(ox - EXT_T - 0.45, oy, ox - EXT_T - 0.45, oy + H, '1-Dim_axis-in');
      line(ox - EXT_T - 0.55, oy, ox - EXT_T - 0.35, oy, '1-Dim_axis-in');
      line(ox - EXT_T - 0.55, oy + H, ox - EXT_T - 0.35, oy + H, '1-Dim_axis-in');
      text(ox - EXT_T - 0.6, oy + H / 2, 0.11, `CH ${Math.round(H * 1000)}`, '1-Dim_axis-in');
      text(ox + W / 2, oy + H + 0.55, 0.14, `${r.name} 단면`, '2-Tx_2_5');
      text(ox + W / 2, oy + 0.25, 0.09,
           `바닥 ${item(r.floorFinish)?.name ?? ''} / 벽 ${item(r.wallFinish)?.name ?? ''} / 천장 ${item(r.ceilFinish)?.name ?? ''}`,
           'A-FIN');
      EXT(ox - EXT_T - 0.7, oy - finT - SLAB - 0.2);
      secX += W + EXT_T * 2 + 1.2;
    }
    // 벽-바닥 접합 상세 (4배 확대, 참조용)
    {
      const k = 4, dx0 = secX + 0.8, dy0 = secBaseY - 1.2;
      poly([[dx0, dy0], [dx0 + 0.9 * k, dy0], [dx0 + 0.9 * k, dy0 + 0.04 * k], [dx0, dy0 + 0.04 * k]], 'A-CON', true);   // 슬래브 상단부
      line(dx0 + 0.15 * k, dy0 + 0.04 * k, dx0 + 0.9 * k, dy0 + 0.04 * k, 'A-FIN');                                        // 바닥 마감
      line(dx0 + 0.15 * k, dy0 + 0.052 * k, dx0 + 0.9 * k, dy0 + 0.052 * k, 'A-FIN');
      poly([[dx0, dy0 + 0.04 * k], [dx0 + 0.15 * k, dy0 + 0.04 * k], [dx0 + 0.15 * k, dy0 + 0.6 * k], [dx0, dy0 + 0.6 * k]], 'A-CON', true);  // 벽
      line(dx0 + 0.15 * k + 0.01 * k, dy0 + 0.052 * k, dx0 + 0.15 * k + 0.01 * k, dy0 + 0.6 * k, 'A-FIN');                  // 벽 마감
      poly([[dx0 + 0.15 * k, dy0 + 0.052 * k], [dx0 + 0.18 * k, dy0 + 0.052 * k],
            [dx0 + 0.18 * k, dy0 + 0.132 * k], [dx0 + 0.15 * k, dy0 + 0.132 * k]], 'A-FIN', true);                          // 걸레받이 H80
      text(dx0 + 0.45 * k, dy0 + 0.75 * k, 0.13, '벽-바닥 접합 상세 (4배 확대)', '2-Tx_2_5');
      text(dx0 + 0.55 * k, dy0 + 0.2 * k, 0.09, '걸레받이 H80 / 바닥 마감층 / 벽 마감', 'A-FIN');
      EXT(dx0 + 1.0 * k, dy0 - 0.3);
    }
    // 우물천장 단면 상세 (4배 확대, 참조용)
    {
      const k = 4, dx = secX + 0.8 + 1.0 * k + 1.0, dy = secBaseY - 1.2;
      const ySl = dy + 0.5 * k;                                             // 상부 슬래브 하단
      const yC = dy + 0.3 * k;                                              // 중앙 평천장 마감면
      const yB = yC - 0.12 * k;                                             // 밴드 하단 (단내림 120)
      poly([[dx, ySl], [dx + 0.9 * k, ySl],
            [dx + 0.9 * k, ySl + 0.06 * k], [dx, ySl + 0.06 * k]], 'A-CON', true);                       // 상부 슬래브
      for (const hx2 of [0.5, 0.65, 0.8]) line(dx + hx2 * k, ySl, dx + hx2 * k, yC + 0.03 * k, 'A-FIN'); // 달대/행거
      poly([[dx, yB], [dx + 0.35 * k, yB], [dx + 0.35 * k, yC], [dx, yC]], 'A-FIN', true);               // 둘레 목틀 단내림 밴드 W350
      line(dx, yB, dx + 0.35 * k, yB, 'A-FIN');                            // 석고보드 1P (상)
      line(dx, yB - 0.01 * k, dx + 0.35 * k, yB - 0.01 * k, 'A-FIN');      // 석고보드 1P (하)
      line(dx, yB - 0.015 * k, dx + 0.35 * k, yB - 0.015 * k, 'A-FIN');    // 마감(도배)선
      line(dx + 0.35 * k, yB - 0.015 * k, dx + 0.35 * k, yC, 'A-FIN');     // 단내림 수직 연결부
      line(dx + 0.35 * k, yC, dx + 0.9 * k, yC, 'A-FIN');                  // 중앙 평천장 마감
      line(dx + 0.35 * k, yC + 0.01 * k, dx + 0.9 * k, yC + 0.01 * k, 'A-FIN');  // 평천장 석고 1P
      text(dx + 0.45 * k, dy + 0.75 * k, 0.13, '우물천장 상세 (4배)', '2-Tx_2_5');
      text(dx + 0.55 * k, (yB + yC) / 2, 0.08, '단내림 120', '2-Tx_2_5');
      text(dx + 0.17 * k, yB - 0.07 * k, 0.08, '밴드 W350', '2-Tx_2_5');
      text(dx + 0.65 * k, ySl - 0.15 * k, 0.08, '목틀 30×30 @450', 'A-FIN');
      text(dx + 0.17 * k, yB - 0.15 * k, 0.08, '석고 9.5T+도배', 'A-FIN');
      EXT(dx + 1.0 * k, dy - 0.1); EXT(dx, dy + 0.85 * k);
    }
    // 간접등 커튼박스 상세 (4배 확대, 참조용)
    {
      const k = 4, dx = secX + 0.8 + 2.0 * k + 2.0, dy = secBaseY - 1.2;
      const ySl = dy + 0.5 * k;                                             // 천장 슬래브 하단
      const yC = dy + 0.42 * k;                                             // 천장 마감면
      const wallX = dx + 0.6 * k;                                           // 벽 내측면
      poly([[dx, ySl], [dx + 0.8 * k, ySl],
            [dx + 0.8 * k, ySl + 0.06 * k], [dx, ySl + 0.06 * k]], 'A-CON', true);                       // 천장 슬래브
      poly([[wallX, dy], [wallX + 0.15 * k, dy], [wallX + 0.15 * k, ySl], [wallX, ySl]], 'A-CON', true); // 벽체
      const bx0 = wallX - 0.3 * k, by0 = yC - 0.18 * k;                     // 커튼박스 300×180
      line(dx, yC, bx0, yC, 'A-FIN');                                      // 천장 마감선 (박스 앞까지)
      poly([[bx0, by0], [wallX, by0], [wallX, yC], [bx0, yC]], 'A-FIN', true);                           // 커튼박스 (목공)
      const lx2 = bx0 + 0.07 * k, ly2 = by0 + 0.05 * k;                     // 간접조명 위치
      arc(lx2, ly2, 0.08, 0, 360, 'A-ETC');
      line(lx2 - 0.02 * k, ly2 + 0.03 * k, lx2 - 0.06 * k, yC - 0.02 * k, 'A-ETC');   // 빛 화살표(상향)
      line(lx2 + 0.01 * k, ly2 + 0.04 * k, lx2 - 0.02 * k, yC - 0.01 * k, 'A-ETC');
      arc(wallX - 0.05 * k, by0 + 0.03 * k, 0.04, 0, 360, 'A-FIN');        // 커튼레일
      line(wallX - 0.05 * k, by0, wallX - 0.05 * k, by0 - 0.15 * k, 'A-FIN');          // 커튼 드롭
      text(dx + 0.4 * k, dy + 0.75 * k, 0.13, '간접등 커튼박스 상세 (4배)', '2-Tx_2_5');
      text(bx0 + 0.15 * k, by0 - 0.08 * k, 0.08, '커튼박스 300×180', '2-Tx_2_5');
      text(dx + 0.14 * k, ly2, 0.08, 'T5/LED 간접', 'A-FIN');
      text(bx0 - 0.1 * k, yC - 0.06 * k, 0.08, '몰딩 마감', 'A-FIN');
      text(wallX - 0.12 * k, by0 - 0.22 * k, 0.08, '커튼레일 공간', 'A-FIN');
      EXT(dx + 0.9 * k, dy - 0.1); EXT(dx, dy + 0.85 * k);
    }
  }

  if (!isFinite(mnX)) return;
  text(mnX + 0.2, mnY - 0.6, 0.2, `${P.name || 'PlanShot'}  ${P.company || ''}  단위 mm`, '2-Tx_2_5', 0);
  text(mnX + 0.2, mnY - 0.95, 0.12, '개략 실측 — 시공 발주 전 정밀실측 필요 / iPhone LiDAR', '2-Tx_2_5', 0);
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
  const layers = [['0', 7], ['0-Sheet', 6], ['1-Axis', 9], ['1-Dim_axis', 150], ['1-Dim_axis-in', 8],
                  ['1-SYM_room', 6], ['2-Tx_2_5', 150], ['2-Tx_1_5', 150],
                  ['A-CON', 3], ['A-FIN', 8], ['A-WIN-sec', 150], ['A-DOOR-plan', 8],
                  ['A-FUR', 64], ['A-HATCH', 64], ['A-ETC', 9]];
  g(0, 'TABLE'); g(2, 'LAYER'); g(70, String(layers.length));
  for (const [nm, c] of layers) { g(0, 'LAYER'); g(2, nm); g(70, '64'); g(62, String(c)); g(6, 'CONTINUOUS'); }
  g(0, 'ENDTAB');
  g(0, 'TABLE'); g(2, 'STYLE'); g(70, '2');
  g(0, 'STYLE'); g(2, 'STANDARD'); g(70, '0'); g(40, '0.0'); g(41, '1.0'); g(50, '0.0'); g(71, '0'); g(42, '2.5'); g(3, 'HDOTUM.TTF'); g(4, '');
  g(0, 'STYLE'); g(2, 'DOTUM'); g(70, '0'); g(40, '0.0'); g(41, '1.0'); g(50, '0.0'); g(71, '0'); g(42, '2.5'); g(3, 'HDOTUM.TTF'); g(4, '');
  g(0, 'ENDTAB'); g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'BLOCKS'); g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'ENTITIES');
  const all = [...head, ...ents, '0', 'ENDSEC', '0', 'EOF'];
  return all.join('\r\n') + '\r\n';
}

export function exportDXF() {
  const str = buildDXFString();
  if (!str) return;
  const blob = new Blob([str], { type: 'application/dxf' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (state.project?.name || 'minibim') + '_plan.dxf';
  a.click();
  URL.revokeObjectURL(a.href);
}
