// DXF 구조 검증기 — AutoCAD 멈춤 원인 탐지 (그룹코드 짝, NaN/거대좌표, 섹션 균형,
// 레이어 참조/문자셋, R12 심볼명 규칙, 중복 테이블 엔트리, POLYLINE 짝)
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { pathToFileURL } from 'url';
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const base = (await import('url')).fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/');   // tests/ 기준 앱 루트
const st = await import(pathToFileURL(base + 'js/state.js'));
const dxf = await import(pathToFileURL(base + 'js/dxf.js'));
st.loadJSONText(readFileSync(base + 'sample/sample_project.json', 'utf-8'), 'sample');
const s = dxf.buildDXFString();
mkdirSync(new URL('./.out/', import.meta.url), { recursive: true });
writeFileSync(new URL('./.out/out_sample.dxf', import.meta.url), s, 'utf-8');

const lines = s.split(/\r\n|\n/);
if (lines[lines.length - 1] === '') lines.pop();
const problems = [];
const warn = [];

// 1) 짝 검증
if (lines.length % 2 !== 0) problems.push('줄 수 홀수: ' + lines.length);

// 숫자 그룹코드 집합 (좌표·크기·각도·스케일)
const numeric = c => (c >= 10 && c <= 59) || (c >= 140 && c <= 147) || (c >= 210 && c <= 239) || c === 62 || c === 66 || c === 70 || c === 71 || c === 72 || c === 73;
const floatish = c => (c >= 10 && c <= 59) || (c >= 140 && c <= 147) || (c >= 210 && c <= 239);

let secDepth = 0, tabDepth = 0, plineOpen = 0, eof = false;
const tableLayers = new Set(), usedLayers = new Set(), usedStyles = new Set(), tableStyles = new Set();
let inLayerTable = false, inStyleTable = false, curEnt = '', lastLayerNameCtx = '';
const dupLayer = [];

for (let i = 0; i < lines.length; i += 2) {
  const code = parseInt(lines[i], 10);
  const val = lines[i + 1];
  if (Number.isNaN(code)) { problems.push(`L${i + 1}: 그룹코드 숫자 아님 "${lines[i]}"`); continue; }
  if (floatish(code)) {
    const f = parseFloat(val);
    if (!Number.isFinite(f)) problems.push(`L${i + 2}: 코드 ${code} 값 비정상 "${val}" (엔티티 ${curEnt})`);
    else if (Math.abs(f) > 1e7) problems.push(`L${i + 2}: 코드 ${code} 거대 좌표 ${f} (엔티티 ${curEnt})`);
  }
  if (code === 0) {
    curEnt = val;
    if (val === 'SECTION') secDepth++;
    else if (val === 'ENDSEC') { secDepth--; inLayerTable = inStyleTable = false; }
    else if (val === 'TABLE') tabDepth++;
    else if (val === 'ENDTAB') { tabDepth--; inLayerTable = inStyleTable = false; }
    else if (val === 'POLYLINE') plineOpen++;
    else if (val === 'SEQEND') plineOpen--;
    else if (val === 'EOF') eof = true;
  }
  if (code === 2 && curEnt === 'TABLE') {
    inLayerTable = val === 'LAYER'; inStyleTable = val === 'STYLE';
  }
  if (code === 2 && curEnt === 'LAYER' && inLayerTable) {
    if (tableLayers.has(val)) dupLayer.push(val);
    tableLayers.add(val);
  }
  if (code === 2 && curEnt === 'STYLE' && inStyleTable) tableStyles.add(val);
  if (code === 8) usedLayers.add(val);
  if (code === 7 && secDepth && !inStyleTable) usedStyles.add(val);
}
if (secDepth !== 0) problems.push('SECTION/ENDSEC 불균형: ' + secDepth);
if (tabDepth !== 0) problems.push('TABLE/ENDTAB 불균형: ' + tabDepth);
if (plineOpen !== 0) problems.push('POLYLINE/SEQEND 불균형: ' + plineOpen);
if (!eof) problems.push('EOF 없음');
if (dupLayer.length) problems.push('LAYER 테이블 중복: ' + [...new Set(dupLayer)].join(', '));

// 레이어 참조 무결성 + R12 심볼명 규칙(공백·마침표는 R12 스펙 밖)
const missing = [...usedLayers].filter(l => !tableLayers.has(l));
if (missing.length) problems.push('테이블에 없는 레이어 사용: ' + missing.join(', '));
const acadver = (s.match(/\$ACADVER[\s\S]*?\n1\r?\n(\S+)/) || [])[1] || '(없음)';
for (const l of new Set([...tableLayers, ...usedLayers])) {
  if (!/^[A-Za-z0-9$_\-]+$/.test(l)) {
    (acadver === 'AC1009' ? problems : warn).push(`레이어명 R12 규칙 위반(공백/특수문자): "${l}"`);
  }
}
const missStyle = [...usedStyles].filter(x => !tableStyles.has(x));
if (missStyle.length) warn.push('테이블에 없는 STYLE 사용: ' + missStyle.join(', '));

// 길이 0 LINE(시작=끝) — 일부 명령에서 무한루프 유발 가능성
let zeroLines = 0;
for (let i = 0; i < lines.length; i += 2) {
  if (lines[i + 1] === 'LINE' && parseInt(lines[i], 10) === 0) {
    const g = {};
    for (let j = i + 2; j < lines.length && parseInt(lines[j], 10) !== 0; j += 2) g[lines[j].trim()] = parseFloat(lines[j + 1]);
    if (Math.abs(g['10'] - g['11']) < 1e-9 && Math.abs(g['20'] - g['21']) < 1e-9) zeroLines++;
  }
}
if (zeroLines) warn.push('길이 0 LINE ' + zeroLines + '개');

console.log('ACADVER:', acadver, '· 줄', lines.length, '· 레이어(테이블)', tableLayers.size, '· 사용', usedLayers.size);
console.log('STYLE 테이블:', [...tableStyles].join(', '), '· 사용:', [...usedStyles].join(', '));
if (problems.length) { console.log('\n■ 문제(멈춤 후보):'); problems.forEach(p => console.log('  ✗', p)); }
if (warn.length) { console.log('\n■ 경고:'); warn.forEach(p => console.log('  △', p)); }
if (!problems.length) console.log('\n구조 검증 통과 — 멈춤 원인은 다른 곳(뷰포트/폰트/외부참조) 가능성');
