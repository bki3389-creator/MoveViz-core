// 편집 연산 검증: 개구부 추가/수정/슬라이드, 벽 이동, 가벽, 가구, 스케일 보정, 언두, 견적 반영.
import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const base = (await import('url')).fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/');   // tests/ 기준 앱 루트
const st = await import(pathToFileURL(base + 'js/state.js'));
const est = await import(pathToFileURL(base + 'js/estimate.js'));

st.loadJSONText(readFileSync(base + 'sample/sample_project.json', 'utf-8'), 'sample');
const P = st.state.project;
const bed = P.rooms.find(r => r.name === '침실1');
const A = (c, msg) => { if (!c) throw new Error('FAIL: ' + msg); };

// 1) 개구부 추가 (b1 벽: (3.6,0)-(3.6,4.2), dir x — 개구부 없는 외벽)
const w0 = st.wallsOf(bed).find(w => w.key === 'b1');
A(w0 && w0.dir === 'x' && Math.abs(w0.pos - 3.6) < 1e-9, 'b1 벽 식별');
const oi = st.addOpening(bed, w0, 'window', 1.8);
A(bed.plan.openings.length === 3, '개구부 3개');
let op = bed.plan.openings[oi];
A(Math.abs(op.width - 1.5) < 1e-9 && Math.abs((op.span[0] + op.span[1]) / 2 - 1.8) < 0.06, '창 1.5m 중심배치: ' + op.span);

// 2) 폭 수정 + 슬라이드 클램프
st.updateOpening(bed, oi, { width: 1.2 });
op = bed.plan.openings[oi];
A(Math.abs(Math.abs(op.span[1] - op.span[0]) - 1.2) < 1e-9, '폭 1.2 반영');
st.slideOpening(bed, oi, st.wallsOf(bed).find(w => w.key === 'b1'), 0);
op = bed.plan.openings[oi];
A(op.span[0] >= 0.019, '슬라이드 좌측 클램프: ' + op.span[0]);

// 3) wallsOf 가 새 개구부를 매칭하고 idx 를 돌려주는지
const w0b = st.wallsOf(bed).find(w => w.key === 'b1');
A(w0b.openings.some(x => x.idx === oi), 'wallsOf idx 매칭');

// 4) 외곽 벽 이동: b0 (z=0 가로변) → z=-0.2 → 깊이 4.4
st.moveWall(bed, 'b0', -0.2);
let m = st.metricsOf(bed);
A(Math.abs(m.d - 4.4) < 1e-6, '벽 이동 후 깊이 4.4: ' + m.d);
A(bed.plan.openings.some(x => x.wall_dir === 'z' && Math.abs((x.wall_pos ?? 9) - (-0.2)) < 1e-9), '개구부 wall_pos 동반 이동');
A(Math.abs(bed.plan.rooms[0].area_m2 - 3.6 * 4.4) < 0.01, 'rooms 폴리곤 동기화');

// 5) 언두 → 원복
st.undo();
m = st.metricsOf(bed);
A(Math.abs(m.d - 4.2) < 1e-6, '언두 후 깊이 4.2');

// 6) 가벽 추가 + 벽체 유형 견적 반영
st.addInnerWall(bed, 1.8, 0, 1.8, 4.2);
A(bed.plan.xw.length === 1, '가벽 xw 추가');
const iw = st.wallsOf(bed).find(w => w.inner);
A(iw && Math.abs(iw.len - 4.2) < 1e-6, '가벽 길이 4.2');
bed.wallTypes[iw.key] = 'wt_stud';
bed.wallOverrides[iw.key] = 'wl_paint';
let e = est.buildEstimate();
const studRow = e.rows.find(x => x.id === 'wt_stud');
A(studRow && Math.abs(studRow.qty - 4.2 * 2.31) < 0.05, '가벽 신설 견적: ' + studRow?.qty);
const ovRow = e.rows.find(x => x.cat === '벽(개별)' && x.roomName === '침실1');
A(ovRow && Math.abs(ovRow.qty - 4.2 * 2.31 * 2) < 0.05, '내부벽 개별 마감 양면 견적: ' + ovRow?.qty);
// 내부벽 오버라이드가 기본 벽마감 수량을 깎지 않는지
const baseWall = e.rows.find(x => x.cat === '벽' && x.roomName === '침실1');
const m2 = st.metricsOf(bed);
A(Math.abs(baseWall.qty - m2.wallNet) < 0.05, '기본 벽마감 수량 유지: ' + baseWall.qty + ' vs ' + m2.wallNet);

// 7) 가벽 삭제 시 그 벽 개구부 청소
const before = bed.plan.openings.length;
st.addOpening(bed, st.wallsOf(bed).find(w => w.inner), 'door', 2.0);
A(bed.plan.openings.length === before + 1, '가벽에 문 추가');
st.removeInnerWall(bed, st.wallsOf(bed).find(w => w.inner).key);
A(bed.plan.xw.length === 0, '가벽 삭제');
A(bed.plan.openings.length === before, '가벽 문 동반 삭제');

// 8) 가구: 추가/이동/회전/치수
const fi = st.addFurniture(bed, 'table', '책상 1200', 1.2, 0.6, 1.8, 2.1);
st.moveFurniture(bed, fi, 0.5, -0.3);
let f = bed.plan.furniture[fi];
let cx = f.obb.reduce((a, p) => a + p[0], 0) / 4;
A(Math.abs(cx - 2.3) < 1e-9, '가구 이동');
st.rotateFurniture(bed, fi);
f = bed.plan.furniture[fi];
const w = Math.hypot(f.obb[1][0] - f.obb[0][0], f.obb[1][1] - f.obb[0][1]);
A(Math.abs(w - 1.2) < 1e-9 && f.yaw_deg === 90, '가구 회전(yaw 90, 변 길이 유지)');
st.resizeFurniture(bed, fi, 1.6, 0.7);
const f2 = bed.plan.furniture[fi];
const w2 = Math.hypot(f2.obb[1][0] - f2.obb[0][0], f2.obb[1][1] - f2.obb[0][1]);
A(Math.abs(w2 - 1.6) < 1e-9, '가구 리사이즈');
st.removeFurniture(bed, fi);

// 9) 스케일 보정: 3.6→3.75 / 4.2 유지
st.scaleRoom(bed, 3.75, 0);
m = st.metricsOf(bed);
A(Math.abs(m.w - 3.75) < 1e-6 && Math.abs(m.d - 4.2) < 1e-6, '레이저 보정: ' + m.w + '×' + m.d);
A(Math.abs(bed.plan.rooms[0].area_m2 - 3.75 * 4.2) < 0.01, '보정 후 면적');

// 10) 최종 견적 이상 없음
e = est.buildEstimate();
A(e.total > 0 && e.rows.length > 10, '최종 견적 ' + e.rows.length + '행 ' + Math.round(e.total));

console.log('편집 연산 검증 ALL OK —', e.rows.length, '행, 총계', Math.round(e.total).toLocaleString(), '원');
