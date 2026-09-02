// 전체 검증 스위트 러너 — node tests/run_all.mjs (repo 어디서든, node 18+)
// 회귀 7종 + 엣지 85 어서션 + DXF/CSV 감사 17 어서션 + DXF 구조 검증기.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('./', import.meta.url));
const SUITE = [
  'test_minibim.mjs', 'test_minibim2.mjs', 'test_ux1.mjs', 'test_ux2.mjs',
  'test_split.mjs', 'test_furncsv.mjs', 'test_audit.mjs',
  'edge.test.mjs', 'audit_dxf_csv.mjs', 'validate_dxf.mjs',
];

let fail = 0;
for (const f of SUITE) {
  const r = spawnSync(process.execPath, [here + f], { encoding: 'utf-8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const bad = r.status !== 0 || /FAIL|fail=[1-9]|✗/.test(out);
  console.log((bad ? '✗ FAIL ' : '✓ OK   ') + f);
  if (bad) { fail++; console.log(out.split('\n').slice(-14).join('\n')); }
}
console.log(fail ? `\n${fail}개 실패` : '\n전체 통과');
process.exit(fail ? 1 : 0);
