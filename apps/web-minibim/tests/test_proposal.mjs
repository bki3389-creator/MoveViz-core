// 제안 데이터의 비용·복원·공유 계약. 브라우저/전역 프로젝트에 의존하지 않아야 한다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { state, loadJSONText } from '../js/state.js';
import { buildEstimate } from '../js/estimate.js';
import { buildProposal, applyProposal, snapshotProposalProject } from '../js/proposal-model.js';
import { makeShareLink, parseShareHash } from '../js/share.js';

const clone = value => JSON.parse(JSON.stringify(value));
const close = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-7, `${message}: ${a} / ${b}`);
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const invariant = estimate => {
  close(estimate.rows.reduce((sum, row) => sum + row.amount, 0), estimate.sub, '행 합계 = 소계');
  close(estimate.subM + estimate.subL, estimate.sub, '재료 + 노무 = 소계');
  close(estimate.sub + estimate.vat, estimate.total, '소계 + VAT = 총액');
};
loadJSONText(readFileSync(new URL('../sample/sample_apt3.json', import.meta.url), 'utf8'), 'sample');
const project = clone(state.project);
const roomId = project.rooms[0].id;
project.rooms[0].wallOverrides = { b0: 'wl_wood' };
project.rates = { wl_silk: { m: 7300, l: 8200 } };
const biz = freeze({ myRates: { wl_silk: { m: 5000, l: 6000 }, fl_tile600: { m: 41000, l: 42000 } }, marginPct: 12 });
const original = clone(project);
freeze(project);

// 1. 비교 계산과 적용은 입력/전역 데이터를 변경하지 않는다. 비용은 동일한 정식 엔진을 사용한다.
const unrelated = freeze({ version: 1, rooms: [], rates: {}, vatPct: 10 });
state.project = unrelated;
state.customerView = true; // 명시적 함수 인수가 전역 고객 모드보다 우선한다.
const proposal = buildProposal(project, { biz });
assert.equal(proposal.roomId, roomId);
assert.equal(proposal.selectedId, 'warm');
assert.deepEqual(proposal.options.map(option => option.id), ['current', 'warm', 'calm']);
assert.deepEqual(project, original);
assert.equal(state.project, unrelated);
for (const option of proposal.options) {
  invariant(option.estimate);
  close(option.estimate.total, buildEstimate(option.project, { biz, customerView: false }).total, '정식 엔진 총액');
  close(option.delta, option.estimate.total - proposal.baseline.estimate.total, '전체 공사비 차액');
  assert.deepEqual(option.project.rooms.slice(1), original.rooms.slice(1), '다른 실은 동일');
  assert.deepEqual(option.project.rooms[0].plan, original.rooms[0].plan, '구조·가구는 동일');
  assert.deepEqual(option.project.rooms[0].lights, original.rooms[0].lights, '조명은 동일');
  assert.deepEqual(option.project.rooms[0].wallOverrides, original.rooms[0].wallOverrides, '개별 벽 마감 유지');
}
const warm = proposal.options[1], calm = proposal.options[2];
assert.equal(warm.estimate.rows.find(row => row.id === 'wl_silk').m, 7300, '현장 단가 > 내 단가');
assert.equal(calm.estimate.rows.find(row => row.id === 'fl_tile600').m, 41000, '내 단가 적용');
assert.ok(calm.delta > warm.delta, '포세린/도장 실제 단가 차이');
const wallChange = warm.changes.find(change => change.kind === 'wall');
close(wallChange.qty, warm.estimate.rows.find(row => row.roomId === roomId && row.cat === '벽').qty, '개별 벽을 제외한 실제 마감 수량');

// 2. 공유벽 개구부 수량은 인수 프로젝트를 따른다. 전역이 다른 프로젝트여도 결과가 같다.
const connected = clone(project);
connected.rooms[1].pos = { x: 5.5, z: 0 };
connected.rooms[1].plan.openings.push({ type: 'door', wall_dir: 'x', wall_pos: 0, span: [0.1, 0.9], height: 2 });
state.project = connected;
const expectedConnected = buildEstimate(connected, { biz, customerView: false });
state.project = unrelated;
const actualConnected = buildEstimate(connected, { biz, customerView: false });
assert.deepEqual(actualConnected, expectedConnected, '전역 프로젝트의 공유벽과 혼동하지 않는다');
assert.notEqual(actualConnected.rows.find(row => row.roomId === roomId && row.cat === '부자재').qty,
  buildEstimate({ ...connected, rooms: [connected.rooms[0]] }, { biz, customerView: false }).rows.find(row => row.cat === '부자재').qty,
  '다른 실 개구부가 걸레받이에 실제 반영된다');

// 3. 적용은 반복해도 동일하고, 다른 스타일로 바꿔도 최초 기준을 유지한다.
const appliedWarm = applyProposal(project, 'warm');
assert.deepEqual(applyProposal(appliedWarm, 'warm'), appliedWarm, '동일안 적용 멱등성');
assert.equal(buildProposal(appliedWarm, { biz }).appliedId, 'warm');
close(buildProposal(appliedWarm, { biz }).baseline.estimate.total, proposal.baseline.estimate.total, '적용 후 기존 견적 보존');
const appliedCalm = applyProposal(appliedWarm, 'calm');
assert.equal(appliedCalm.proposal.selectedStyle, 'calm');
assert.deepEqual(appliedCalm.proposal.baseline, appliedWarm.proposal.baseline);
const restored = applyProposal(appliedCalm, 'current');
assert.deepEqual(restored.rooms, original.rooms, '최초 마감과 색상 오버라이드 부재까지 복원');
close(buildEstimate(restored, { biz, customerView: false }).total, proposal.baseline.estimate.total, '복원 견적 동일');
assert.ok(!('plan' in appliedWarm.proposal.baseline), '복원 메타데이터에 구조를 저장하지 않는다');

// 4. 그 사이 추가된 가구·조명·기하·다른 실 변경은 복원 시에도 유지한다.
const edited = clone(appliedWarm);
edited.rooms[0].plan.furniture[0].status = 'dispose';
edited.rooms[0].plan.boundary[1][0] += 0.3;
edited.rooms[0].lights.push({ id: 'new', type: 'lt_down3', x: 1, z: 1 });
edited.rooms[1].wallFinish = 'wl_paint';
const restoredEdited = applyProposal(edited, 'current');
assert.deepEqual(restoredEdited.rooms[0].plan, edited.rooms[0].plan);
assert.deepEqual(restoredEdited.rooms[0].lights, edited.rooms[0].lights);
assert.deepEqual(restoredEdited.rooms[1], edited.rooms[1]);

// 5. 수동 마감 편집 뒤에는 오래된 기준으로 덮지 않고 새 기준을 만든다.
const manuallyFinished = clone(appliedWarm);
manuallyFinished.rooms[0].floorFinish = 'fl_herring';
manuallyFinished.rooms[0].finishColors.wall = 0xddeeff;
const stale = buildProposal(manuallyFinished, { biz });
assert.equal(stale.stale, true);
assert.equal(stale.appliedId, null);
assert.equal(stale.baseline.project.rooms[0].floorFinish, 'fl_herring');
const newCalm = applyProposal(manuallyFinished, 'calm');
assert.deepEqual(applyProposal(newCalm, 'current').rooms, manuallyFinished.rooms, '최근 수동 수정으로 복원');

// 6. 저장/고객 링크는 회사 단가·이윤을 고정하고 열람자의 설정과 무관하게 모든 안이 일치한다.
const baked = snapshotProposalProject(appliedCalm, biz);
const link = await makeShareLink(baked, { name: '테스트 시공사' }, 'https://example.test/');
const shared = await parseShareHash(link.slice(link.indexOf('#')));
assert.deepEqual(shared.p, baked, '압축 링크 왕복');
const customer = buildProposal(shared.p, { biz: { myRates: { wl_silk: { m: 1, l: 1 } }, marginPct: 95 }, customerView: true });
const pro = buildProposal(appliedCalm, { biz });
for (let i = 0; i < pro.options.length; i++) {
  close(customer.options[i].estimate.total, pro.options[i].estimate.total, '공유 후 각 대안 총액');
  close(customer.options[i].delta, pro.options[i].delta, '공유 후 차액');
}
assert.equal(customer.selectedId, 'calm');
const zeroProject = { ...appliedWarm, marginPct: 0 };
const zeroBaked = snapshotProposalProject(zeroProject, biz);
assert.equal(zeroBaked.marginPct, 0, '현장 0% 이윤 보존');
assert.ok(!buildEstimate(zeroBaked, { biz, customerView: false }).rows.some(row => row.id === 'biz_margin'));
close(buildEstimate(zeroBaked, { customerView: true }).total, buildEstimate(zeroProject, { biz, customerView: false }).total, '0% 공유 총액');
assert.deepEqual(project, original);

// 7. 중복 실명도 선택한 실만 합산하고, 손상된/악의적 메타데이터는 구조를 덮지 않는다.
const sameNames = clone(project);
sameNames.rooms[1].name = sameNames.rooms[0].name;
const duplicate = buildProposal(sameNames, { biz });
close(duplicate.baseline.roomSubtotal, proposal.baseline.roomSubtotal, '동일 이름의 실 소계 분리');
for (const malformed of [null, [], 9, 'broken', { roomId, baseline: [] },
  { ...appliedWarm.proposal, selectedStyle: '__proto__' },
  { ...appliedWarm.proposal, selectedStyle: { toString: null } },
  { ...appliedWarm.proposal, version: 999 },
  { ...appliedWarm.proposal, baseline: { ...appliedWarm.proposal.baseline, finishColors: { wall: 'red' } } }]) {
  const damaged = { ...appliedWarm, proposal: malformed };
  assert.equal(buildProposal(damaged, { biz }).appliedId, null);
  assert.deepEqual(applyProposal(damaged, 'current').rooms, appliedWarm.rooms, '손상 메타데이터로 과거 상태를 복원하지 않는다');
}
const injected = clone(appliedWarm);
injected.proposal.baseline.plan = { boundary: [[0, 0]] };
injected.proposal.baseline.rates = { wl_silk: 1 };
assert.deepEqual(applyProposal(injected, 'current').rooms, original.rooms, 'baseline의 마감 외 필드 무시');
assert.deepEqual(buildProposal(null).options, []);
assert.deepEqual(buildProposal({ rooms: [] }).options, []);
assert.throws(() => applyProposal(project, 'unknown'), RangeError);
const wetOnly = { ...project, rooms: [project.rooms.find(room => /욕실/.test(room.name))] };
assert.equal(buildProposal(wetOnly).eligible, false, '습식 공간에 거실 마감 스타일을 제안하지 않는다');
assert.deepEqual(buildProposal(wetOnly).options.map(option => option.id), ['current']);
assert.throws(() => applyProposal(wetOnly, 'warm'), RangeError);
assert.equal(state.project, unrelated, '모든 계산/공유 후 전역 프로젝트 동일');
console.log('제안 검증 ALL OK — 불변식 · 순수 계산 · 공유벽 · 마감 복원 · 수동 편집 · 고객 링크 · 0% 이윤');
