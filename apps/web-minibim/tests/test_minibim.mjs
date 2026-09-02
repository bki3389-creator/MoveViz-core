// 미니BIM 로직 검증 (node): 샘플 프로젝트 → 벽/개구부 매칭·수량·견적 합계.
import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';

const base = (await import('url')).fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/');   // tests/ 기준 앱 루트
const state = await import(pathToFileURL(base + 'js/state.js'));
const est = await import(pathToFileURL(base + 'js/estimate.js'));
const cat = await import(pathToFileURL(base + 'js/catalog.js'));

// localStorage 스텁 (autosave 리스너)
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const sample = readFileSync(base + 'sample/sample_project.json', 'utf-8');
state.loadJSONText(sample, 'sample_project.json');

const P = state.state.project;
console.log('rooms:', P.rooms.map(r => r.name).join(', '));

for (const r of P.rooms) {
  const m = state.metricsOf(r);
  const walls = state.wallsOf(r);
  const outer = walls.filter(w => !w.inner);
  const ops = outer.reduce((s, w) => s + w.openings.filter(x => !x.foreign).length, 0);
  console.log(`[${r.name}] area=${m.area.toFixed(2)} per=${m.per.toFixed(2)} H=${m.H} wallNet=${m.wallNet.toFixed(2)} ` +
    `doors=${m.doors} windows=${m.windows} 매칭개구부=${ops} 벽수=${outer.length}`);
  if (ops !== (r.plan.openings || []).length) throw new Error(r.name + ': 개구부 매칭 누락!');
}

// 거실 검산: 둘레 L자 = 6+3+2+2+4+6? boundary (0,0)(6,0)(6,3)(4,3)(4,5)(0,5): 6+3+2+2+5? 변: 6,3,2,2,4,5 = 22
const living = P.rooms[0], lm = state.metricsOf(living);
console.assert(Math.abs(lm.area - 26.0) < 0.01, '거실 면적');
console.assert(Math.abs(lm.per - 22.0) < 0.01, '거실 둘레 ' + lm.per);
// 벽 순면적 = 50.82 − 자체개구부 9.61 − 공유벽(침실 문) 1.89 = 39.32
console.assert(Math.abs(lm.wallNet - 39.32) < 0.06, '거실 벽 순면적 ' + lm.wallNet);

const { rows, sub, vat, total } = est.buildEstimate();
console.log('견적 행:', rows.length);
for (const x of rows.slice(0, 6)) console.log('  ', x.roomName, x.cat, x.name, x.qty.toFixed(2), '×', x.rate, '=', Math.round(x.amount));
console.log('소계', Math.round(sub), '부가세', Math.round(vat), '총계', Math.round(total));
console.assert(total > 0 && vat > 0, '견적 합계');

// 조명 수량: 거실 다운3 ×3 + 라인 3.2m + 펜던트 1
const lightRows = rows.filter(x => x.cat === '조명' && x.roomName === '거실');
console.log('거실 조명 행:', lightRows.map(x => `${x.name}=${x.qty.toFixed(2)}${x.unit}`).join(', '));
const line = lightRows.find(x => x.id === 'lt_line');
console.assert(line && Math.abs(line.qty - 3.2) < 0.01, '라인조명 길이 ' + line?.qty);

// 배치 오프셋
const offs = state.layoutOffsets();
console.log('offsets:', Object.entries(offs).map(([k, v]) => `${P.rooms.find(r=>r.id===k)?.name}@${v.x.toFixed(1)}`).join(' '));

console.log('ALL OK');
