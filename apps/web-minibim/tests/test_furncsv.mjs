import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const base = (await import('url')).fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/');   // tests/ 기준 앱 루트
const st = await import(pathToFileURL(base + 'js/state.js'));
const est = await import(pathToFileURL(base + 'js/estimate.js'));
st.loadJSONText(readFileSync(base + 'sample/sample_project.json', 'utf-8'), 'sample');
const A = (c, m) => { if (!c) throw new Error('FAIL: ' + m); };
const liv = st.state.project.rooms.find(r => r.name === '거실');
st.addFurniture(liv, 'table', '식탁 4인', 1.2, 0.8, 1.0, 4.0);          // 신규
st.setFurnStatus(liv, 0, 'dispose');                                    // 기존 폐기
st.replaceFurniture(liv, 1, { category: 'sofa', name: '소파 3인', w: 2.0, d: 0.9, oldKg: 40 });  // 교체
const e = est.buildEstimate();
const furnRows = e.rows.filter(x => x.cat === '가구');
A(furnRows.some(x => x.name.includes('식탁 4인') && x.spec === '신규'), '신규 가구 행');
A(furnRows.some(x => x.name.includes('소파 3인') && x.spec === '교체'), '교체 가구 행');
const outRow = e.rows.find(x => String(x.id).startsWith('w_furnout'));
A(outRow && outRow.qty > 0, '가구 반출 자동 행: ' + outRow?.qty);
A(e.demoTons > 0, 'demoTons 연동: ' + e.demoTons);
st.addExtra(liv, 'w_furnout#1', 0.5);                                   // 수동 입력 시 중복 방지
const e2 = est.buildEstimate();
A(e2.rows.filter(x => String(x.id).startsWith('w_furnout')).length === 1, '자동/수동 중복 방지');
console.log('가구 견적/CSV 자동 반영 ALL OK —',
  furnRows.map(x => x.name + ' ' + x.amount.toLocaleString() + '원').join(' · '),
  '/ 반출', outRow.qty + '톤');
