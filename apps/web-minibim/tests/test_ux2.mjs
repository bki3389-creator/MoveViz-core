import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const base = (await import('url')).fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/');   // tests/ 기준 앱 루트
const st = await import(pathToFileURL(base + 'js/state.js'));
const cat = await import(pathToFileURL(base + 'js/catalog.js'));
st.loadJSONText(readFileSync(base + 'sample/sample_project.json', 'utf-8'), 'sample');
const A = (c, m) => { if (!c) throw new Error('FAIL: ' + m); };
const liv = st.state.project.rooms.find(r => r.name === '거실');
const bed = st.state.project.rooms.find(r => r.name === '침실1');

// 1) 걸레받이: 상대방 소유 문 폭 공제 (22 - 0.9(자기) - 0.9(침실문) = 20.2)
const m = st.metricsOf(liv);
A(Math.abs(m.baseboard - 20.2) < 0.01, '거실 걸레받이 20.2: ' + m.baseboard);
A(Math.abs(st.metricsOf(bed).baseboard - 14.7) < 0.01, '침실 걸레받이 14.7');

// 2) flip/dk/dm 이 wallsOf 개구부에 전파되는지 (렌더러가 읽는 경로)
const bw = st.wallsOf(bed).find(w => w.openings.some(o => !o.foreign && o.type === 'door'));
const bop = bw.openings.find(o => !o.foreign && o.type === 'door');
st.flipDoor(bed, bop.idx);
const bop2 = st.wallsOf(bed).find(w => w.openings.some(o => !o.foreign && o.type === 'door'))
  .openings.find(o => !o.foreign && o.type === 'door');
A(bop2.flip === 1, 'flip 전파: ' + bop2.flip);
st.updateOpening(bed, bop.idx, { dk: 'slide', dm: 'glass' });
const bop3 = st.wallsOf(bed).find(w => w.openings.some(o => !o.foreign && o.type === 'door'))
  .openings.find(o => !o.foreign && o.type === 'door');
A(bop3.dk === 'slide' && bop3.dm === 'glass', 'dk/dm 전파');
st.undo(); st.undo();

// 3) 가구 라이프사이클: 스캔 가구 existing 기본값
A(liv.plan.furniture.every(f => f.existing === true), '스캔 가구 existing');
const fi = st.addFurniture(liv, 'table', '식탁 4인', 1.2, 0.8, 2.0, 2.0);
A(liv.plan.furniture[fi].existing === false, '신규 가구 existing=false');

// 4) 폐기: furnDisposalKg 는 폐기·교체분만
A(cat.furnDisposalKg(liv.plan.furniture) === 0, '초기 반출 0');
st.setFurnStatus(liv, 0, 'dispose');
const kg1 = cat.furnDisposalKg(liv.plan.furniture);
A(kg1 > 0, '폐기 무게: ' + kg1);
st.setFurnStatus(liv, 0, 'keep');
A(cat.furnDisposalKg(liv.plan.furniture) === 0, '유지 복귀 시 0');

// 5) 같은 자리 교체: 중심 유지 + 기존 무게 기록
const f0 = liv.plan.furniture[0];
const cs0 = f0.obb;
const cx0 = cs0.reduce((a, p) => a + p[0], 0) / 4, cz0 = cs0.reduce((a, p) => a + p[1], 0) / 4;
st.replaceFurniture(liv, 0, { category: 'sofa', name: '소파 3인', w: 2.0, d: 0.9, oldKg: 40 });
const f1 = liv.plan.furniture[0];
const cx1 = f1.obb.reduce((a, p) => a + p[0], 0) / 4, cz1 = f1.obb.reduce((a, p) => a + p[1], 0) / 4;
A(Math.abs(cx1 - cx0) < 1e-9 && Math.abs(cz1 - cz0) < 1e-9, '교체 후 중심 유지');
A(f1.replaced?.kg === 40 && f1.category === 'sofa', '교체 기록');
A(cat.furnDisposalKg(liv.plan.furniture) === 40, '교체분 반출 40kg');
st.undo();

console.log('UX2 검증 ALL OK — 걸레받이 공제·flip/dk/dm 전파·가구 라이프사이클');
