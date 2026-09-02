// 라운드10 이후 DXF/견적 실측 검증 (node) — 회귀 6종+감사 7종 통과분 위의 잔여 결함 탐지
import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const base = (await import('url')).fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/');   // tests/ 기준 앱 루트
const st = await import(pathToFileURL(base + 'js/state.js'));
const cat = await import(pathToFileURL(base + 'js/catalog.js'));
const dxfm = await import(pathToFileURL(base + 'js/dxf.js'));
const est = await import(pathToFileURL(base + 'js/estimate.js'));

let pass = 0, fail = 0;
const results = [];
const T = (name, fn) => {
  try { fn(); pass++; results.push(['PASS', name]); }
  catch (err) { fail++; results.push(['FAIL', name + ' :: ' + err.message]); }
};
const A = (c, m) => { if (!c) throw new Error(m); };
const near = (a, b, t = 1e-6) => Math.abs(a - b) <= t;

st.loadJSONText(readFileSync(base + 'sample/sample_project.json', 'utf-8'), 'sample');
const P = st.state.project;
st.layoutOffsets();

// ── DXF 파서 ──
function parsePairs(s) {
  A(s.endsWith('\r\n'), 'CRLF 종료 아님');
  const lines = s.split('\r\n'); lines.pop();
  A(lines.length % 2 === 0, '줄수 홀수(코드/값 쌍 깨짐): ' + lines.length);
  const pairs = [];
  for (let i = 0; i < lines.length; i += 2) {
    A(/^-?\d+$/.test(lines[i]), `짝수줄이 정수 그룹코드 아님 @${i}: "${lines[i]}" (직전값 "${lines[i - 1]}")`);
    pairs.push([+lines[i], lines[i + 1]]);
  }
  return pairs;
}
function sections(pairs) {
  const out = {};
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i][0] === 0 && pairs[i][1] === 'SECTION') {
      const name = pairs[i + 1][1];
      let j = i + 2;
      while (j < pairs.length && !(pairs[j][0] === 0 && pairs[j][1] === 'ENDSEC')) j++;
      out[name] = pairs.slice(i + 2, j);
      i = j;
    }
  }
  return out;
}
function entitiesOf(sec) {
  const ents = []; let cur = null;
  for (const [c, v] of sec) {
    if (c === 0) { cur = { type: v, g: {} }; ents.push(cur); continue; }
    if (!cur) continue;
    if (cur.g[c] === undefined) cur.g[c] = v; else { if (!Array.isArray(cur.g[c])) cur.g[c] = [cur.g[c]]; cur.g[c].push(v); }
  }
  return ents;
}
const uesc = s => [...String(s)].map(ch => {
  const c = ch.codePointAt(0);
  return c > 126 ? '\\U+' + c.toString(16).toUpperCase().padStart(4, '0') : ch;
}).join('');

// ═══ ① 기본 DXF ═══
const s1 = dxfm.buildDXFString();
A(s1 && s1.length > 5000, 'DXF 생성 실패');
const pairs1 = parsePairs(s1);
const sec1 = sections(pairs1);
const ents1 = entitiesOf(sec1.ENTITIES);

T('①-a 그룹코드 짝 무결성(짝수줄·정수코드)', () => { /* parsePairs가 이미 검증 */ });

T('①-b STYLE DOTUM 존재(+STANDARD, HDOTUM.TTF)', () => {
  const styles = entitiesOf(sec1.TABLES).filter(e => e.type === 'STYLE');
  A(styles.some(e => e.g[2] === 'DOTUM' && e.g[3] === 'HDOTUM.TTF'), 'DOTUM 스타일 없음: ' + styles.map(e => e.g[2]));
  A(styles.some(e => e.g[2] === 'STANDARD'), 'STANDARD 없음');
});

T('①-c HEADER EXTMIN<EXTMAX', () => {
  const H = sec1.HEADER;
  const val = (name) => {
    const i = H.findIndex(p => p[0] === 9 && p[1] === name);
    A(i >= 0, name + ' 없음');
    const out = {};
    for (let j = i + 1; j < H.length && H[j][0] !== 9; j++) out[H[j][0]] = parseFloat(H[j][1]);
    return out;
  };
  const mn = val('$EXTMIN'), mx = val('$EXTMAX');
  A(mn[10] < mx[10] && mn[20] < mx[20], `EXTMIN(${mn[10]},${mn[20]}) !< EXTMAX(${mx[10]},${mx[20]})`);
});

T('①-d 모든 엔티티 레이어가 LAYER 테이블에 존재', () => {
  const layerTab = new Set(entitiesOf(sec1.TABLES).filter(e => e.type === 'LAYER').map(e => e.g[2]));
  const used = new Set(ents1.map(e => e.g[8]).filter(Boolean));
  const missing = [...used].filter(l => !layerTab.has(l));
  A(!missing.length, '테이블 밖 레이어: ' + missing.join(','));
});

T('①-e 치수 텍스트 개수 = 규칙 기대값', () => {
  let expect = 0;
  for (const r of P.rooms) {
    for (const w of st.wallsOf(r)) {
      if (w.inner) continue;
      const sharedLen = (w.shared || []).reduce((s2, sp) => s2 + sp.hi - sp.lo, 0);
      if (sharedLen < w.len * 0.6) expect++;
      const own = w.openings.filter(o => !o.foreign).sort((a, b) => a.lo - b.lo);
      if (own.length) {
        const stops = [w.lo, ...own.flatMap(o => [o.lo, o.hi]), w.hi];
        for (let i = 0; i + 1 < stops.length; i++) if (stops[i + 1] - stops[i] >= 0.08) expect++;
      }
    }
    if ((r.plan.boundary || []).length > 4) expect += 2;
    expect += 1;   // 단면 CH 텍스트(1-Dim_axis-in)
  }
  const got = ents1.filter(e => e.type === 'TEXT' && (e.g[8] === '1-Dim_axis' || e.g[8] === '1-Dim_axis-in')).length;
  A(got === expect, `치수 텍스트 ${got} ≠ 기대 ${expect}`);
});

T('①-f 우물천장/커튼박스 상세 문자열(\\U+ 이스케이프) 존재', () => {
  for (const t of ['우물천장 상세 (4배)', '간접등 커튼박스 상세 (4배)', '단내림 120', '밴드 W350', '커튼박스 300×180', 'T5/LED 간접']) {
    A(s1.includes(uesc(t)), '누락: ' + t + ' (이스케이프 ' + uesc(t).slice(0, 30) + '…)');
  }
});

T('①-g 벽 이중선 중복 엔티티 없음(무개구부 벽 2회 드로잉 여부)', () => {
  const sig = new Map();
  for (const e of ents1) {
    if (e.type !== 'LINE') continue;
    const k = [e.g[8], e.g[10], e.g[20], e.g[11], e.g[21]].join('|');
    sig.set(k, (sig.get(k) || 0) + 1);
  }
  const dups = [...sig.entries()].filter(([, n2]) => n2 > 1);
  // 원인 진단용: 컷 없는 외곽/내부 벽 수 → 예상 중복선 수 = 벽수×2
  let uncut = 0;
  for (const r of P.rooms) for (const w of st.wallsOf(r)) if (!st.wallCuts(w).length) uncut++;
  A(!dups.length, `중복 LINE ${dups.reduce((s2, [, n2]) => s2 + n2 - 1, 0)}개 (서명 ${dups.length}종) — 컷 없는 벽 ${uncut}개 × 이중선 2 = ${uncut * 2} 예상과 비교. 예: ${dups[0]?.[0]}`);
});

T('①-h 세로벽(dir=x) 여닫이문 호 각도 정합', () => {
  // 욕실1 문: wall_dir 'x', wall_pos 0, span[0.5,1.3] — doorGeom으로 기대 각 산출
  const bath = P.rooms.find(r => r.name === '욕실1');
  const off = st.layoutOffsets()[bath.id];
  const w = st.wallsOf(bath).find(w2 => w2.dir === 'x' && w2.openings.some(o => !o.foreign && o.type === 'door'));
  const o = w.openings.find(o2 => !o2.foreign && o2.type === 'door');
  const dg = st.doorGeom(w, o, bath.plan.boundary);
  const X = x => (off.x + x) * 1000, Y = z => -(off.z + z) * 1000;
  const cx = X(dg.hx), cy = Y(dg.hz);
  const arcE = ents1.filter(e => e.type === 'ARC' && e.g[8] === 'A-DOOR-plan')
    .find(e => near(+e.g[10], cx, 0.2) && near(+e.g[20], cy, 0.2));
  A(arcE, '욕실 문 호 자체가 없음(중심 ' + cx + ',' + cy + ')');
  const a0 = +e50(arcE), a1 = +e51(arcE);
  function e50(e) { return e.g[50]; } function e51(e) { return e.g[51]; }
  // 기대: 열린 문짝 각(법선 방향)과 닫힌 문짝 각(벽 진행 방향, DXF Y반전) 두 각
  const leafAng = Math.atan2(Y(dg.hz + dg.nz * dg.sgn * o.w) - cy, X(dg.hx + dg.nx * dg.sgn * o.w) - cx) * 180 / Math.PI;
  const jambAng = Math.atan2(Y(dg.hz + dg.az * o.w) - cy, X(dg.hx + dg.ax * o.w) - cx) * 180 / Math.PI;
  const norm = a => ((a % 360) + 360) % 360;
  const set = [norm(a0), norm(a1)];
  const hit = a => set.some(v => near(v, norm(a), 0.5));
  A(hit(leafAng) && hit(jambAng),
    `호 각도 [${a0}°,${a1}°] ≠ 기대 {문짝 ${leafAng.toFixed(1)}°, 잼 ${jambAng.toFixed(1)}°}`);
  A(!(near(norm(a0), norm(a1), 0.01)), `호 시작=끝 (${a0}°) — 0도/전원 호`);
});

// ═══ ② 미닫이+유리문 ═══
const bed = P.rooms.find(r => r.name === '침실1');
const bedWall = st.wallsOf(bed).find(w2 => w2.openings.some(o => !o.foreign && o.type === 'door'));
const bedDoor = bedWall.openings.find(o => !o.foreign && o.type === 'door');
st.updateOpening(bed, bedDoor.idx, { dk: 'slide', dm: 'glass' });
const s2 = dxfm.buildDXFString();
const ents2 = entitiesOf(sections(parsePairs(s2)).ENTITIES);

T('②-a 미닫이 설정 후 그 문 위치에 ARC 미생성', () => {
  const off = st.layoutOffsets()[bed.id];
  const dg = st.doorGeom(bedWall, bedDoor, bed.plan.boundary);
  const cxA = (off.x + dg.hx) * 1000, cyA = -(off.z + dg.hz) * 1000;   // 힌지(호 중심)
  const doorArcs2 = ents2.filter(e => e.type === 'ARC' && (e.g[8] === 'A-DOOR-plan' || e.g[8] === 'A-WIN-sec'));
  const nearDoor = doorArcs2.filter(e => Math.abs(+e.g[10] - cxA) < 50 && Math.abs(+e.g[20] - cyA) < 50);
  A(!nearDoor.length, '미닫이인데 힌지 위치에 호 존재: ' + nearDoor.length);
  const arcsBefore = ents1.filter(e => e.type === 'ARC' && e.g[8] === 'A-DOOR-plan').length;
  const arcsAfter = ents2.filter(e => e.type === 'ARC' && e.g[8] === 'A-DOOR-plan').length;
  A(arcsAfter === arcsBefore - 1, `A-DOOR-plan 호 ${arcsBefore}→${arcsAfter} (기대 -1)`);
});

T('②-b 유리 미닫이 패널 라인 2개가 A-WIN-sec(구 A-GLAZ)에 존재', () => {
  A(!s2.includes('A-GLAZ'), 'A-GLAZ 레이어는 r9에서 A-WIN-sec으로 대체 — 존재하면 회귀');
  const off = st.layoutOffsets()[bed.id];
  const pw2 = bedDoor.w * 0.55, noff = 0.035;
  const Xp = x => (off.x + x) * 1000, Yp = z => -(off.z + z) * 1000;
  // dir 'x' 벽: 패널 = 세로 라인, x = pos±noff, span [lo, lo+pw2], [hi-pw2, hi]
  const want = [
    [Xp(bedWall.pos + noff), Yp(bedDoor.lo), Yp(bedDoor.lo + pw2)],
    [Xp(bedWall.pos - noff), Yp(bedDoor.hi - pw2), Yp(bedDoor.hi)],
  ];
  for (const [wx, y0, y1] of want) {
    const hitL = ents2.some(e => e.type === 'LINE' && e.g[8] === 'A-WIN-sec'
      && near(+e.g[10], wx, 0.2) && near(+e.g[11], wx, 0.2)
      && near(Math.min(+e.g[20], +e.g[21]), Math.min(y0, y1), 0.2)
      && near(Math.max(+e.g[20], +e.g[21]), Math.max(y0, y1), 0.2));
    A(hitL, `패널 라인 없음 x=${wx} y=[${y0},${y1}]`);
  }
});

// ═══ ③ 견적: 폐기+교체+신규 가구 ═══
const living = P.rooms.find(r => r.name === '거실');
const sofaIdx = living.plan.furniture.findIndex(f => f.category === 'sofa');
st.setFurnStatus(living, sofaIdx, 'dispose');
const bedIdx = bed.plan.furniture.findIndex(f => f.category === 'bed');
const bcs = bed.plan.furniture[bedIdx].obb;
const bw = Math.hypot(bcs[1][0] - bcs[0][0], bcs[1][1] - bcs[0][1]);
const bd2 = Math.hypot(bcs[3][0] - bcs[0][0], bcs[3][1] - bcs[0][1]);
const bedOldKg = cat.furnKgOf('bed', bw, bd2);
st.replaceFurniture(bed, bedIdx, { category: 'bed', name: '침대 Q', w: 1.5, d: 2.0, oldKg: bedOldKg });
st.addFurniture(living, 'table', '책상 1200', 1.2, 0.6, 2.0, 2.0);   // 신규

const E = est.buildEstimate();

T('③-a rows 합계 = sub/subM/subL/total 재검산', () => {
  const sum = E.rows.reduce((s2, x) => s2 + x.amount, 0);
  const sumM = E.rows.reduce((s2, x) => s2 + x.amountM, 0);
  const sumL = E.rows.reduce((s2, x) => s2 + x.amountL, 0);
  A(near(sum, E.sub, 0.01), `Σamount ${sum} ≠ sub ${E.sub}`);
  A(near(sumM, E.subM, 0.01) && near(sumL, E.subL, 0.01), 'M/L 소계 불일치');
  A(near(sumM + sumL, E.sub, 0.01), 'subM+subL ≠ sub');
  A(near(E.vat, E.sub * (P.vatPct || 0) / 100, 0.01), 'vat 불일치');
  A(near(E.total, E.sub + E.vat, 0.01), 'total 불일치');
});

T('③-b 교체/신규 가구 행 단가·금액', () => {
  const rep = E.rows.find(x => x.cat === '가구' && x.spec === '교체');
  A(rep && rep.name === '침대 Q 구입·설치' && near(rep.amount, 600000), '교체 행: ' + JSON.stringify(rep));
  A(rep.note.includes('침대'), '교체 비고에 기존 가구명 없음: ' + rep.note);
  const nw = E.rows.find(x => x.cat === '가구' && x.spec === '신규');
  A(nw && nw.name === '책상 1200 구입·설치' && near(nw.amount, 200000), '신규 행: ' + JSON.stringify(nw));
});

T('③-c 반출 톤·demoTons 재검산(앱 공식 그대로)', () => {
  const livKg = cat.furnDisposalKg(living.plan.furniture);   // 폐기 소파 40kg
  const bedKg = cat.furnDisposalKg(bed.plan.furniture);      // 교체 침대 55kg
  // 신공식(수정 후): kg>0 이면 최소 0.1t 청구 — 50kg 미만 반올림 소실 방지
  const ton = kg => kg > 0 ? Math.max(0.1, Math.round(kg / 100) / 10) : 0;
  const livTon = ton(livKg), bedTon = ton(bedKg);
  const outRows = E.rows.filter(x => String(x.id).startsWith('w_furnout'));
  const expRows = [livTon, bedTon].filter(t => t > 0).length;
  A(outRows.length === expRows, `반출 행 수 ${outRows.length} ≠ 공식상 ${expRows} (거실 ${livKg}kg→${livTon}t, 침실 ${bedKg}kg→${bedTon}t)`);
  for (const [nm, t] of [['거실', livTon], ['침실1', bedTon]]) {
    const row = outRows.find(x => x.roomName === nm);
    if (t > 0) A(row && near(row.qty, t, 1e-9), `${nm} 반출 ${row?.qty} ≠ ${t}`);
  }
  const expTons = Math.round(outRows.reduce((s2, x) => s2 + x.qty * 1000, 0) / 100) / 10;
  A(near(E.demoTons, expTons, 1e-9), `demoTons ${E.demoTons} ≠ ${expTons}`);
});

T('③-g [결함검증] 폐기 지정 가구가 견적 어딘가에 반영되는가(50kg 미만 소실)', () => {
  // 소파 40kg 폐기: Math.round(40/100)/10 = 0.0t → w_furnout 행·demoTons 모두 소실
  const livRow = E.rows.find(x => String(x.id).startsWith('w_furnout') && x.roomName === '거실');
  A(livRow, '거실 소파(40kg) 폐기 지정했는데 반출 행 없음 — estimate.js:80 Math.round(kg/100)/10 이 50kg 미만을 0으로 절사');
});

T('③-d rows 전 필드 NaN/undefined 없음(CSV 안전)', () => {
  for (const x of E.rows) {
    for (const k of ['roomName', 'cat', 'id', 'name', 'unit']) A(typeof x[k] === 'string' && x[k] !== 'undefined', `${k} 이상: ${JSON.stringify(x)}`);
    A(x.spec !== undefined, 'spec undefined: ' + x.name);
    for (const k of ['qty', 'm', 'l', 'rate', 'amountM', 'amountL', 'amount'])
      A(typeof x[k] === 'number' && isFinite(x[k]), `${k}=${x[k]} @ ${x.name}`);
  }
  for (const d of E.laborDays) A(isFinite(d.days) && isFinite(d.won), 'laborDays NaN');
  // CSV 텍스트 재구성(다운로드 제외 로직 복제)해 NaN/undefined 문자열 검사
  let csv = '';
  for (const x of E.rows) csv += [x.roomName, x.cat, x.name, x.spec, x.unit, x.unit === 'ea' ? Math.round(x.qty) : Number(x.qty.toFixed(2)), x.m, Math.round(x.amountM), x.l, Math.round(x.amountL), Math.round(x.amount), x.note || ''].join(',') + '\n';
  A(!/NaN|undefined/.test(csv), 'CSV에 NaN/undefined 문자열');
});

T('③-e 천장유형 ct_keep 0원 행이 견적에 끼지 않아야(ct.rate 사어 필드)', () => {
  const ghost = E.rows.filter(x => x.id === 'ct_keep');
  A(!ghost.length, `'기존 천장 유지' 0원 행 ${ghost.length}개 (${ghost.map(x => x.roomName)}) — estimate.js:42 'ct.rate!==0'인데 CEIL_TYPES에 rate 필드 없음(mat/lab 분리)`);
});

T('③-f 폐기 가구 DXF 제외·신규 가구 포함(A-FUR 폴리라인 수)', () => {
  const s3 = dxfm.buildDXFString();
  const ents3 = entitiesOf(sections(parsePairs(s3)).ENTITIES);
  const polys = ents3.filter(e => e.type === 'POLYLINE' && e.g[8] === 'A-FUR').length;
  let expectF = 0;
  for (const r of P.rooms) for (const f of r.plan.furniture || []) {
    if (f.status === 'dispose') continue;
    if (((f.obb || f.polygon || []).length) >= 3) expectF++;
  }
  A(polys === expectF, `A-FUR 폴리 ${polys} ≠ 기대 ${expectF}`);
});

let out = '';
for (const [s2r, name] of results) out += s2r + '  ' + name + '\n';
console.log(out);
console.log(`== ${pass} passed, ${fail} failed ==`);
process.exit(0);
