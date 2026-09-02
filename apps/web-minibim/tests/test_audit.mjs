// 감사 확정 결함 재현 → 수정 검증
import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const base = (await import('url')).fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/');   // tests/ 기준 앱 루트
const st = await import(pathToFileURL(base + 'js/state.js'));
const est = await import(pathToFileURL(base + 'js/estimate.js'));
const A = (c, m) => { if (!c) throw new Error('FAIL: ' + m); };
const fresh = () => {
  st.loadJSONText(readFileSync(base + 'sample/sample_project.json', 'utf-8'), 'sample');
  return st.state.project.rooms.find(r => r.name === '침실1');
};
const doorsOf = r => {
  let n = 0;
  for (const w of st.wallsOf(r)) for (const o of w.openings) if (!o.foreign && o.type === 'door') n++;
  return n;
};

// ── 1) 스플릿 절단이 문 스팬을 회피 (b3 왼쪽 벽: 문 span z 1.0~1.9)
let bed = fresh();
const mi1 = st.splitWall(bed, 'b3', 1.4);   // 문 한복판 클릭 → 회피해서 분할되거나 실패해야
if (mi1 >= 0) {
  const ws = st.wallsOf(bed);
  const doorOK = ws.some(w => w.openings.some(o => !o.foreign && o.type === 'door' && Math.abs((o.hi - o.lo) - 0.9) < 0.01));
  A(doorOK, '스플릿 후 문 폭 0.9 보존(관통 안 됨)');
}
A(doorsOf(bed) === 1, '스플릿 회피 후 문 1개 유지');

// ── 2) 스플릿 → 가운데 조각 드래그해도 다른 조각의 문 생존 (moveWall 스팬 검사)
bed = fresh();
const mi2 = st.splitWall(bed, 'b3', 3.3);   // 문(1.0~1.9)에서 떨어진 지점 분할
A(mi2 >= 0, '분할 성공');
// 점진 드래그 시뮬레이션 (0.05 스텝 → 총 0.5m)
for (let k = 1; k <= 10; k++) st.moveWall(bed, 'b' + mi2, 0 - 0.05 * k, true);
A(doorsOf(bed) === 1, '가운데 조각 0.5m 드래그 후 문 생존: ' + doorsOf(bed));
const dOp = bed.plan.openings.find(o => o.type === 'door');
A(Math.abs(dOp.wall_pos - 0) < 1e-9, '문 wall_pos 원위치 유지: ' + dOp.wall_pos);

// ── 3) 끝단 그립(moveCorner) 법선 드래그 → 그 벽 문 동반 이동(소실 금지)
bed = fresh();
// b3 = 왼쪽 벽 x=0 (문 있음). 꼭짓점 3(0,4.2)~0(0,0) — b3의 끝점 v3? b3: bd[3]->bd[0].
// 그립 = 꼭짓점 3을 x쪽으로 0.3 드래그 → 수직 이웃 변(x=0, 문 포함)이 x=0.3으로 이동
st.moveCorner(bed, 3, 0.3, 4.2);
const dOp2 = bed.plan.openings.find(o => o.type === 'door');
A(Math.abs(dOp2.wall_pos - 0.3) < 1e-9, '코너 드래그 시 문 wall_pos 동기: ' + dOp2.wall_pos);
A(doorsOf(bed) === 1, '코너 드래그 후 문 생존');

// ── 4) 스플릿 스텁(0길이 이웃) 그립 드래그 → 대각선 금지(스텁 동행)
bed = fresh();
const mi4 = st.splitWall(bed, 'b1', 2.1);   // 오른쪽 벽(문 없음)
const vTop = mi4;                            // 가운데 조각 시작 꼭짓점(중복점 C')
st.moveCorner(bed, vTop, 3.4, 1.9);
for (let i = 0; i < bed.plan.boundary.length; i++) {
  const a = bed.plan.boundary[i], b = bed.plan.boundary[(i + 1) % bed.plan.boundary.length];
  const dx = Math.abs(b[0] - a[0]), dz = Math.abs(b[1] - a[1]);
  A(dx < 1e-6 || dz < 1e-6, `대각 변 금지: 변${i} (${dx.toFixed(3)},${dz.toFixed(3)})`);
}

// ── 5) splitWall 후 wallTypes/wallOverrides 리매핑
bed = fresh();
bed.wallTypes['b2'] = 'wt_demo';            // 하단 벽 철거 표시
bed.wallOverrides['b2'] = 'wl_paint';
st.splitWall(bed, 'b1', 2.1);               // b1 분할 → b2는 b6이 되어야
A(bed.wallTypes['b6'] === 'wt_demo' && !bed.wallTypes['b2'], '벽 유형 리매핑 b2→b6');
A(bed.wallOverrides['b6'] === 'wl_paint', '벽 마감 리매핑');

// ── 6) 내부벽 빠른 점프 드래그 → 문 동반(구 _prev 버그)
bed = fresh();
st.addInnerWall(bed, 1.8, 0, 1.8, 4.2);
const iw = st.wallsOf(bed).find(w => w.inner);
st.addOpening(bed, iw, 'door', 2.0);
st.moveWall(bed, iw.key, 2.4, true);        // 0.6m 한 번에 점프
const iw2 = st.wallsOf(bed).find(w => w.inner);
A(iw2.openings.some(o => o.type === 'door'), '내부벽 점프 드래그 후 문 부착 유지');

// ── 7) 가벽 양면 도배: 오버라이드 없는 가벽 → 기본 벽 수량 +2면
bed = fresh();
const q0 = est.buildEstimate().rows.find(x => x.cat === '벽' && x.roomName === '침실1').qty;
st.addInnerWall(bed, 1.8, 0, 1.8, 4.2);
const q1 = est.buildEstimate().rows.find(x => x.cat === '벽' && x.roomName === '침실1').qty;
A(Math.abs((q1 - q0) - 4.2 * 2.31 * 2) < 0.05, '가벽 양면 도배 합산: +' + (q1 - q0).toFixed(2));

console.log('감사 결함 재현 테스트 ALL OK — 7개 시나리오(회피/하이재킹/코너동기/찢김/리매핑/점프/양면)');
