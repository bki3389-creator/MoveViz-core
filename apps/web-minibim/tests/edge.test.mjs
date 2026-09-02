// 미니BIM 엣지 테스트 — state.js/estimate.js (node, three 미의존)
// 시나리오 ①~⑥ + 보너스(언두×리매핑, 빈 프로젝트 로드 오판)
const _store = new Map();
globalThis.localStorage = {
  getItem: k => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => _store.set(k, String(v)),
  removeItem: k => _store.delete(k),
};

import { pathToFileURL } from 'node:url';
const JS = (await import('node:url')).fileURLToPath(new URL('../js/', import.meta.url)).replace(/\\/g, '/');
const S = await import(pathToFileURL(JS + 'state.js').href);
const E = await import(pathToFileURL(JS + 'estimate.js').href);

const {
  state, newProject, addRoom, normalizePlan, wallsOf, metricsOf, polyArea, polyPerimeter,
  moveWall, moveCorner, splitWall, addOpening, loadJSONText, lightGridOf, doorGeom,
  pointInPoly, addLight, undo,
} = S;
const { buildEstimate } = E;

let pass = 0, fail = 0; const failures = [];
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ok  ' + label); }
  else { fail++; failures.push(label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); console.log('  FAIL ' + label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

function mkPlan(boundary, o = {}) {
  return normalizePlan({
    boundary: boundary.map(p => [...p]),
    xw: o.xw || [], zw: o.zw || [], openings: o.openings || [], furniture: o.furniture || [],
    rooms: [{ name: '방', polygon: boundary.map(p => [...p]), area_m2: polyArea(boundary) }],
    floor_y: 0, ceil_y: 2.4,
  });
}
function fresh(boundary, o) {
  state.project = newProject('T'); state.selRoom = null; state.sel = null;
  return addRoom(mkPlan(boundary, o), '방');
}
const bdOf = r => r.plan.boundary;

// ── ① 음수 좌표 boundary ──────────────────────────────────────
console.log('\n[1] 음수 좌표 방 — moveWall / moveCorner / splitWall');
{
  // 1a moveWall(b0)
  const door = { type: 'door', wall_dir: 'z', wall_pos: -6, span: [-6.5, -5.6], height: 2.1 };
  let r = fresh([[-8, -6], [-4, -6], [-4, -2], [-8, -2]], { openings: [JSON.parse(JSON.stringify(door))] });
  moveWall(r, 'b0', -6.3);
  ok(near(bdOf(r)[0][1], -6.3) && near(bdOf(r)[1][1], -6.3), '1a 변 두 꼭짓점 z=-6.3', bdOf(r)[0][1]);
  // 참고: snap()이 정확히 -6.3이 아닌 FP 잔재를 남기는지(-6.300000000000001) 관찰용
  if (bdOf(r)[0][1] !== -6.3) console.log('  (참고) snap FP 잔재:', bdOf(r)[0][1]);
  ok(near(r.plan.openings[0].wall_pos, -6.3), '1a 문 wall_pos 동기(-6.3)', r.plan.openings[0].wall_pos);
  ok(near(polyArea(bdOf(r)), 4 * 4.3), '1a 면적 17.2', polyArea(bdOf(r)));
  ok(near(r.plan.rooms[0].area_m2, 4 * 4.3), '1a rooms[0] 면적 동기', r.plan.rooms[0].area_m2);
  let w0 = wallsOf(r).find(w => w.key === 'b0');
  ok(w0 && w0.openings.length === 1 && near(w0.openings[0].lo, -6.5) && near(w0.openings[0].hi, -5.6), '1a 벽 b0 개구부 부착', w0 && w0.openings);

  // 1b moveCorner
  r = fresh([[-8, -6], [-4, -6], [-4, -2], [-8, -2]]);
  moveCorner(r, 0, -8.3, -6.4);
  ok(JSON.stringify(bdOf(r)) === JSON.stringify([[-8.3, -6.4], [-4, -6.4], [-4, -2], [-8.3, -2]]), '1b 직교 동행 이동', bdOf(r));
  ok(near(polyArea(bdOf(r)), 4.3 * 4.4), '1b 면적 18.92', polyArea(bdOf(r)));

  // 1c splitWall (문 회피 포함) + 단 만들기
  r = fresh([[-8, -6], [-4, -6], [-4, -2], [-8, -2]], { openings: [JSON.parse(JSON.stringify(door))] });
  const a0 = polyArea(bdOf(r)), m0 = metricsOf(r);
  const mid = splitWall(r, 'b0', -6);
  ok(mid >= 0, '1c split 성공(문 회피)', mid);
  if (mid >= 0) {
    const bd = bdOf(r);
    ok(bd.length === 8, '1c 점 4개 삽입', bd.length);
    ok(near(polyArea(bd), a0), '1c 면적 불변', polyArea(bd));
    const m1 = metricsOf(r);
    ok(near(m1.wallNet, m0.wallNet), '1c wallNet 불변', [m0.wallNet, m1.wallNet]);
    ok(m1.doors === 1, '1c 문 1개 유지', m1.doors);
    // 가운데 조각을 법선으로 -6.5까지: 단(notch)
    const mA = bd[mid], mB = bd[(mid + 1) % bd.length];
    const pieceLen = Math.abs(mB[0] - mA[0]);
    // 문 스팬과 안 겹치는지(스플릿 회피 검증)
    const plo = Math.min(mA[0], mB[0]), phi = Math.max(mA[0], mB[0]);
    ok(phi <= -5.5 - 0.0999 || plo >= -5.6 + 0.9 + 0.0999 || phi <= door.span[0] || plo >= door.span[1], '1c 절단창 문 회피', [plo, phi]);
    ok(wallsOf(r).length === 6, '1c 드래그 전 0길이 스텁 제외 벽 6개', wallsOf(r).map(w => w.key));
    moveWall(r, 'b' + mid, -6.5);
    ok(near(polyArea(bdOf(r)), a0 + pieceLen * 0.5), '1c 단 면적 = +조각길이×0.5', [polyArea(bdOf(r)), a0 + pieceLen * 0.5]);
    ok(near(r.plan.openings[0].wall_pos, -6), '1c 문은 원래 변(-6)에 잔류', r.plan.openings[0].wall_pos);
    const walls = wallsOf(r);
    ok(walls.length === 8, '1c 단 형성 후 스텁 실체화 → 벽 8개', walls.map(w => w.key));
    const m2 = metricsOf(r);
    ok(near(m2.per, polyPerimeter(bdOf(r))) && near(m2.wallNet, m2.per * 2.4 - 0.9 * 2.1), '1c 단 형성 후 wallNet=둘레 기반', [m2.per, m2.wallNet]);
  }
}

// ── ② 시계방향(반전 winding) boundary ─────────────────────────
console.log('\n[2] 시계방향 winding');
{
  const r = fresh([[0, 0], [0, 4], [6, 4], [6, 0]]);   // CW
  let m = metricsOf(r);
  ok(near(m.area, 24) && near(m.per, 20), '2 CW 면적/둘레', [m.area, m.per]);
  ok(near(m.wallNet, 20 * 2.4), '2 wallNet=48', m.wallNet);
  // 문 추가(오른쪽 x=6 벽 = b2)
  const wallB2 = wallsOf(r).find(w => w.key === 'b2');
  ok(wallB2 && wallB2.dir === 'x' && near(wallB2.pos, 6), '2 b2 = x=6 세로벽', wallB2 && [wallB2.dir, wallB2.pos]);
  addOpening(r, wallB2, 'door', 2);
  m = metricsOf(r);
  ok(m.doors === 1 && near(m.wallNet, 48 - 0.9 * 2.1), '2 문 공제 46.11', [m.doors, m.wallNet]);
  // doorGeom: 스윙이 방 안쪽(x<6)으로
  const w2 = wallsOf(r).find(w => w.key === 'b2');
  const g = doorGeom(w2, w2.openings[0], bdOf(r));
  ok(pointInPoly(g.hx + g.nx * g.sgn * 0.3, g.hz + g.nz * g.sgn * 0.3, bdOf(r)), '2 doorGeom 스윙 방 안쪽', g);
  // moveWall(b1: z=4 가로변 → 5)
  moveWall(r, 'b1', 5);
  ok(near(polyArea(bdOf(r)), 30), '2 변 이동 후 면적 30', polyArea(bdOf(r)));
  // splitWall(b0: x=0 세로변) → 가운데 밖으로 0.5
  const mid = splitWall(r, 'b0', 2.5);
  ok(mid >= 0, '2 split 성공', mid);
  if (mid >= 0) {
    const bd = bdOf(r);
    const mA = bd[mid], mB = bd[(mid + 1) % bd.length];
    const pieceLen = Math.abs(mB[1] - mA[1]);
    moveWall(r, 'b' + mid, -0.5);
    ok(near(polyArea(bdOf(r)), 30 + pieceLen * 0.5), '2 CW 단 면적', [polyArea(bdOf(r)), 30 + pieceLen * 0.5]);
    ok(near(r.plan.rooms[0].area_m2, polyArea(bdOf(r))), '2 rooms 폴리곤 동기', r.plan.rooms[0].area_m2);
  }
  // 조명 그리드 전부 내부
  const grid = lightGridOf(r);
  ok(grid.length > 0 && grid.every(([x, z]) => pointInPoly(x, z, bdOf(r))), '2 조명그리드 내부', grid.length);
}

// ── ③ b0 분할 후 wallTypes/wallOverrides 리매핑 ────────────────
console.log('\n[3] b0 분할 → 키 리매핑');
{
  const r = fresh([[0, 0], [6, 0], [6, 4], [0, 4]]);
  r.wallTypes = { b0: 'wt_demo', b1: 'wt_stud', b3: 'wt_demo' };
  r.wallOverrides = { b2: 'wl_paint' };
  const geomBefore = {};
  for (const w of wallsOf(r)) geomBefore[w.key] = [w.x1, w.z1, w.x2, w.z2];
  const mid = splitWall(r, 'b0', 3);
  ok(mid === 2, '3 split b0 → 가운데 b2', mid);
  ok(JSON.stringify(r.wallTypes) === JSON.stringify({ b0: 'wt_demo', b5: 'wt_stud', b7: 'wt_demo' }), '3 wallTypes 리매핑', r.wallTypes);
  ok(JSON.stringify(r.wallOverrides) === JSON.stringify({ b6: 'wl_paint' }), '3 wallOverrides 리매핑', r.wallOverrides);
  const geomAfter = {};
  for (const w of wallsOf(r)) geomAfter[w.key] = [w.x1, w.z1, w.x2, w.z2];
  ok(JSON.stringify(geomAfter.b5) === JSON.stringify(geomBefore.b1), '3 b5 지오메트리 = 구 b1', [geomAfter.b5, geomBefore.b1]);
  ok(JSON.stringify(geomAfter.b6) === JSON.stringify(geomBefore.b2), '3 b6 = 구 b2');
  ok(JSON.stringify(geomAfter.b7) === JSON.stringify(geomBefore.b3), '3 b7 = 구 b3');

  // 보너스: split 후 undo — wallTypes 도 원복되는가?
  const typesBefore = { b0: 'wt_demo', b1: 'wt_stud', b3: 'wt_demo' };
  undo();
  ok(bdOf(r).length === 4, '3u undo 로 boundary 원복', bdOf(r).length);
  ok(JSON.stringify(r.wallTypes) === JSON.stringify(typesBefore), '3u undo 후 wallTypes 원복(리매핑 롤백)', r.wallTypes);
  ok(JSON.stringify(r.wallOverrides) === JSON.stringify({ b2: 'wl_paint' }), '3u undo 후 wallOverrides 원복', r.wallOverrides);
}

// ── ④ 분할 3회 중첩 → 견적 wallNet 불변 ──────────────────────
console.log('\n[4] 중첩 분할 3회 — 수량 불변');
{
  const r = fresh([[0, 0], [6, 0], [6, 4], [0, 4]], {
    openings: [
      { type: 'door', wall_dir: 'z', wall_pos: 0, span: [0.5, 1.4], height: 2.1 },
      { type: 'window', wall_dir: 'z', wall_pos: 4, span: [2, 3.5], height: 1.2 },
    ],
  });
  const m0 = metricsOf(r);
  const est0 = buildEstimate();
  const wallRow0 = est0.rows.find(x => x.cat === '벽');
  ok(near(m0.wallNet, 20 * 2.4 - (0.9 * 2.1 + 1.5 * 1.2)), '4 초기 wallNet 44.31', m0.wallNet);
  let key = 'b0', t = 4.5;
  const mids = [];
  for (let k = 0; k < 3; k++) {
    const mid = splitWall(r, key, t);
    mids.push(mid);
    ok(mid >= 0, `4 split#${k + 1} 성공`, mid);
    if (mid < 0) break;
    const m = metricsOf(r);
    ok(near(m.wallNet, m0.wallNet), `4 split#${k + 1} wallNet 불변`, [m0.wallNet, m.wallNet]);
    ok(near(m.per, m0.per), `4 split#${k + 1} 둘레 불변`, m.per);
    ok(near(m.area, m0.area), `4 split#${k + 1} 면적 불변`, m.area);
    ok(near(m.baseboard, m0.baseboard), `4 split#${k + 1} 걸레받이 불변`, m.baseboard);
    ok(m.doors === 1 && m.windows === 1, `4 split#${k + 1} 개구부 개수 유지`, [m.doors, m.windows]);
    key = 'b' + mid;
  }
  ok(bdOf(r).length === 16, '4 점 4+12', bdOf(r).length);
  const est1 = buildEstimate();
  const wallRow1 = est1.rows.find(x => x.cat === '벽');
  ok(wallRow0 && wallRow1 && near(wallRow0.qty, wallRow1.qty), '4 견적 벽 수량 불변', [wallRow0?.qty, wallRow1?.qty]);
  ok(near(est0.total, est1.total), '4 견적 총계 불변', [est0.total, est1.total]);
  // 개구부(창) 리인덱스 없는 wall_pos 기반이므로 창이 여전히 b? 조각에 부착됐는지
  const winWalls = wallsOf(r).filter(w => w.openings.some(o => o.type === 'window'));
  ok(winWalls.length === 1, '4 창 1개 벽에만 부착', winWalls.map(w => w.key));
}

// ── ⑤ L자 코너 이동 → metricsOf 면적·rooms 폴리곤 동기 ─────────
console.log('\n[5] L자 moveCorner');
{
  const r = fresh([[0, 0], [6, 0], [6, 4], [3, 4], [3, 6], [0, 6]], {
    openings: [{ type: 'window', wall_dir: 'z', wall_pos: 4, span: [4, 5], height: 1.2 }],
  });
  ok(near(metricsOf(r).area, 30), '5 초기 면적 30', metricsOf(r).area);
  moveCorner(r, 3, 3.5, 4.5);
  const bd = bdOf(r);
  ok(JSON.stringify(bd) === JSON.stringify([[0, 0], [6, 0], [6, 4.5], [3.5, 4.5], [3.5, 6], [0, 6]]), '5 boundary 직교 동행', bd);
  ok(near(polyArea(bd), 32.25), '5 면적 32.25', polyArea(bd));
  const m = metricsOf(r);
  ok(near(m.area, 32.25), '5 metricsOf 면적 동기', m.area);
  ok(JSON.stringify(r.plan.rooms[0].polygon) === JSON.stringify(bd), '5 rooms[0].polygon 동기', r.plan.rooms[0].polygon);
  ok(near(r.plan.rooms[0].area_m2, 32.25), '5 rooms[0].area_m2 동기', r.plan.rooms[0].area_m2);
  ok(near(m.per, polyPerimeter(bd)), '5 둘레 동기', [m.per, polyPerimeter(bd)]);
  ok(near(r.plan.openings[0].wall_pos, 4.5), '5 이동 변 위 창 wall_pos 동기(4.5)', r.plan.openings[0].wall_pos);
  const winW = wallsOf(r).find(w => w.openings.length);
  ok(winW && winW.key === 'b2' && near(winW.pos, 4.5), '5 창이 이동된 b2에 부착', winW && [winW.key, winW.pos]);
}

// ── ⑥ 가벽2+문 저장→loadJSONText 라운드트립 ───────────────────
console.log('\n[6] 저장/로드 라운드트립');
{
  const r = fresh([[0, 0], [6, 0], [6, 4], [0, 4]], {
    xw: [{ pos: 2.5, segs: [[0.5, 3.5]], presence: 1, cls: 'added' }],
    zw: [{ pos: 2, segs: [[3, 5.5]], presence: 1, cls: 'added' }],
    openings: [
      { type: 'door', wall_dir: 'z', wall_pos: 0, span: [1, 1.9], height: 2.1, flip: 3, dk: 'slide', dm: 'glass' },
      { type: 'door', wall_dir: 'x', wall_pos: 2.5, span: [1, 1.9], height: 2.1, flip: 1 },
    ],
    furniture: [
      { obb: [[1, 1], [2.5, 1], [2.5, 1.9], [1, 1.9]], category: 'sofa', category_ko: '소파 3인', yaw_deg: 0, existing: true, status: 'dispose' },
      { obb: [[3, 1], [4.5, 1], [4.5, 3], [3, 3]], category: 'bed', category_ko: '침대 Q', yaw_deg: 0, existing: true, replaced: { name: '구침대', category: 'bed', kg: 80 } },
      { obb: [[5, 3], [5.45, 3], [5.45, 3.5], [5, 3.5]], category: 'chair', category_ko: '의자', yaw_deg: 90, existing: false },
    ],
  });
  r.finishColors = { floor: 0x112233, wall: 0x445566 };
  r.wallOverrides = { b1: 'wl_paint' };
  r.wallTypes = { x0_0: 'wt_stud' };
  addLight(r, 'lt_down3', 1.5, 1.5);
  addLight(r, 'lt_line', 1, 3, 4, 3);
  const m0 = metricsOf(r), est0 = buildEstimate();
  const text = JSON.stringify(state.project);

  state.project = null; state.selRoom = null;
  const kind = loadJSONText(text, '라운드트립.json');
  ok(kind === 'project', '6 프로젝트로 인식', kind);
  const r2 = state.project.rooms[0];
  ok(!!r2, '6 방 존재');
  const text2 = JSON.stringify(state.project);
  ok(text2 === text, '6 완전 라운드트립(스키마 무손실)', text2 === text ? undefined : '차이 있음(아래 개별 확인)');
  ok(r2.plan.openings[0].flip === 3 && r2.plan.openings[0].dk === 'slide' && r2.plan.openings[0].dm === 'glass', '6 flip/dk/dm 보존', r2.plan.openings[0]);
  ok(r2.plan.openings[1].flip === 1 && r2.plan.openings[1].wall_dir === 'x', '6 내부벽 문 보존', r2.plan.openings[1]);
  ok(r2.plan.furniture[0].status === 'dispose', '6 status 보존', r2.plan.furniture[0].status);
  ok(r2.plan.furniture[1].replaced?.kg === 80, '6 replaced 보존', r2.plan.furniture[1].replaced);
  ok(r2.plan.furniture[2].existing === false, '6 신규가구 existing:false 유지(normalizePlan 덮어쓰기 없음)', r2.plan.furniture[2].existing);
  ok(JSON.stringify(r2.finishColors) === JSON.stringify({ floor: 0x112233, wall: 0x445566 }), '6 finishColors 보존', r2.finishColors);
  ok(JSON.stringify(r2.wallOverrides) === JSON.stringify({ b1: 'wl_paint' }) && JSON.stringify(r2.wallTypes) === JSON.stringify({ x0_0: 'wt_stud' }), '6 wallOverrides/wallTypes 보존');
  ok(r2.plan.xw.length === 1 && r2.plan.zw.length === 1 && r2.lights.length === 2, '6 가벽2+조명2 보존', [r2.plan.xw.length, r2.plan.zw.length, r2.lights.length]);
  const m1 = metricsOf(r2), est1 = buildEstimate();
  ok(near(m0.wallNet, m1.wallNet) && near(m0.area, m1.area) && m0.doors === m1.doors, '6 수량 동일', [m0, m1].map(m => m.wallNet));
  ok(near(est0.total, est1.total), '6 견적 총계 동일', [est0.total, est1.total]);
  // 가구 견적 반영: 폐기+교체 반출 톤 + 신규/교체 구입
  const furnRows = est1.rows.filter(x => x.cat === '가구');
  ok(furnRows.length === 2, '6 가구 구입행 2(교체+신규)', furnRows.map(x => x.name + '/' + x.spec));
  ok(est1.rows.some(x => String(x.id).startsWith('w_furnout')), '6 반출행 자동', est1.rows.filter(x => String(x.id).startsWith('w_furnout')).map(x => x.qty));
}

// ── 보너스: rooms:[] 빈 프로젝트 파일 로드 오판 ────────────────
console.log('\n[B] 빈 프로젝트(rooms:[]) 로드');
{
  state.project = null;
  let kind = null, err = null;
  try { kind = loadJSONText(JSON.stringify({ version: 1, name: '빈', company: '', client: '', vatPct: 10, rates: {}, rooms: [] }), '빈.json'); }
  catch (e) { err = e.message; }
  ok(kind === 'project', 'B rooms:[] 프로젝트를 project 로 인식', { kind, err, roomsLen: state.project?.rooms?.length, roomPlanIsProject: state.project?.rooms?.[0]?.plan?.version });
}

console.log(`\n결과: pass=${pass} fail=${fail}`);
if (failures.length) { console.log('실패 목록:'); for (const f of failures) console.log(' - ' + f); }
setTimeout(() => process.exit(fail ? 1 : 0), 600);   // autosave 디바운스 소진 후 종료
