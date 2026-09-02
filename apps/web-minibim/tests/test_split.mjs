import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const base = (await import('url')).fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/');   // tests/ 기준 앱 루트
const st = await import(pathToFileURL(base + 'js/state.js'));
const dxf = await import(pathToFileURL(base + 'js/dxf.js'));
st.loadJSONText(readFileSync(base + 'sample/sample_project.json', 'utf-8'), 'sample');
const A = (c, m) => { if (!c) throw new Error('FAIL: ' + m); };
const bed = st.state.project.rooms.find(r => r.name === '침실1');

// 1) 스플릿: b1(우측 외벽, x=3.6 로컬) 중앙 클릭 → 변 2.1±0.45 삽입
const n0 = bed.plan.boundary.length;
const mi = st.splitWall(bed, 'b1', 2.1);
A(mi === 3, '가운데 조각 인덱스: ' + mi);
A(bed.plan.boundary.length === n0 + 4, '점 4개 삽입');
const w2 = st.wallsOf(bed).find(w => w.key === 'b3');
A(w2 && Math.abs(w2.len - 0.9) < 0.01, '가운데 조각 0.9m: ' + w2?.len);
// 2) 가운데 조각을 법선으로 0.3 내밀기 → 단(notch)
st.moveWall(bed, 'b3', 3.9);
const m2 = st.metricsOf(bed);
A(Math.abs(m2.area - (15.12 + 0.9 * 0.3)) < 0.02, '단 내밀기 후 면적: ' + m2.area);
// 3) 코너 그립: b0(z=0 상단벽) 끝점 v1(3.6,0) → (3.8,-0.2) 드래그 — 직교 유지
st.undo(); st.undo();
A(bed.plan.boundary.length === n0, '언두 복원');
const before = JSON.stringify(bed.plan.boundary);
st.moveCorner(bed, 1, 3.8, -0.2);
const bd2 = bed.plan.boundary;
A(Math.abs(bd2[1][0] - 3.8) < 1e-9 && Math.abs(bd2[1][1] + 0.2) < 1e-9, '꼭짓점 이동');
A(Math.abs(bd2[0][1] + 0.2) < 1e-9, '이전 이웃 z 동행(수평 유지)');
A(Math.abs(bd2[2][0] - 3.8) < 1e-9, '다음 이웃 x 동행(수직 유지)');

// 4) DXF 문자열 검증 (돋움·치수·미닫이·폐기 제외)
st.loadJSONText(readFileSync(base + 'sample/sample_project.json', 'utf-8'), 'sample');
const liv = st.state.project.rooms.find(r => r.name === '거실');
st.setFurnStatus(liv, 0, 'dispose');
const bed2 = st.state.project.rooms.find(r => r.name === '침실1');
const bw = st.wallsOf(bed2).find(w => w.openings.some(o => !o.foreign && o.type === 'door'));
st.updateOpening(bed2, bw.openings.find(o => !o.foreign).idx, { dk: 'slide', dm: 'glass' });
const sx = dxf.buildDXFString();
A(sx && sx.length > 10000, 'DXF 생성');
A(sx.includes('DOTUM') && sx.includes('HDOTUM.TTF') && sx.includes('A-CON') && sx.includes('A-FIN') && !sx.includes('A-WALL'), '실무 레이어·돋움');
const dimCnt = (sx.match(/1-Dim_axis/g) || []).length;
A(dimCnt > 150, '치수 대폭 보강: ' + dimCnt);
const dispCat = liv.plan.furniture[0].category_ko || '';
console.log('SPLIT/CORNER/DXF 검증 ALL OK — 치수 엔티티', dimCnt, '· DXF', (sx.length / 1024).toFixed(0) + 'KB');
