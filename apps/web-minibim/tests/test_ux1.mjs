import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const base = (await import('url')).fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/');   // tests/ 기준 앱 루트
const st = await import(pathToFileURL(base + 'js/state.js'));
const est = await import(pathToFileURL(base + 'js/estimate.js'));
const cat = await import(pathToFileURL(base + 'js/catalog.js'));
st.loadJSONText(readFileSync(base + 'sample/sample_project.json', 'utf-8'), 'sample');
const A = (c, m) => { if (!c) throw new Error('FAIL: ' + m); };
const liv = st.state.project.rooms.find(r => r.name === '거실');
// 1) doorGeom 기본: 거실 문 z벽 pos0 span[2.0,2.9] → 경첩 lo(2.0), 스윙 방 안쪽(z+)
const w = st.wallsOf(liv).find(x => x.openings.some(o => !o.foreign && o.type === 'door'));
const op = w.openings.find(o => !o.foreign && o.type === 'door');
let g = st.doorGeom(w, op, liv.plan.boundary);
A(Math.abs(g.hx - 2.0) < 1e-9 && Math.abs(g.hz - 0) < 1e-9, 'hinge lo: ' + g.hx + ',' + g.hz);
A(g.sgn === 1 && g.nz === 1, '스윙 방 안쪽(z+): sgn ' + g.sgn);
// 2) flip 순환: 1=스윙반전, 2=경첩반대, 3=둘다
st.flipDoor(liv, op.idx);
g = st.doorGeom(w, { ...op, flip: 1 }, liv.plan.boundary);
A(g.sgn === -1, 'flip1 스윙 반전');
g = st.doorGeom(w, { ...op, flip: 2 }, liv.plan.boundary);
A(Math.abs(g.hx - 2.9) < 1e-9 && g.ax === -1 && g.sgn === 1, 'flip2 경첩 hi: ' + g.hx + ' ax' + g.ax + ' sgn' + g.sgn);
A(liv.plan.openings[op.idx].flip === 1, 'flipDoor 저장');
st.undo();
A(!(liv.plan.openings[op.idx].flip), 'flip 언두');
// 3) 가구 무게·반출 톤
const kg = cat.furnKgOf('refrigerator', 0.9, 0.8);
A(kg === 110, '냉장고 110kg: ' + kg);
A(cat.furnKgOf('sofa', 2.0, 0.9) === 40, '소파 3인 40kg');
A(cat.item('w_furnout#1').lab === 280000, 'w_furnout 등급');
// 4) 철거 톤 집계: 거실 마감재 전체 철거 + 가구 반출 1.2톤
st.addExtra(liv, 'w_demo#1', 26);
st.addExtra(liv, 'w_furnout#1', 1.2);
const e = est.buildEstimate();
A(Math.abs(e.demoTons - Math.round((26 * 14 + 1200) / 100) / 10) < 0.051, 'demoTons: ' + e.demoTons);
A(e.rows.some(x => x.id === 'w_furnout#1'), '가구 반출 행');
console.log('UX1 검증 ALL OK — demoTons', e.demoTons, '톤, 총계', Math.round(e.total).toLocaleString(), '원');
