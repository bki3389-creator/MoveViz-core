import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { state, loadJSONText } from '../js/state.js';
import { buildEstimate } from '../js/estimate.js';
import { buildProposal, snapshotProposalProject } from '../js/proposal-model.js';
import { changeStudioFinish, applyStudioStyle, buildStudioReview } from '../js/studio-model.js';
loadJSONText(readFileSync(new URL('../sample/sample_apt3.json', import.meta.url), 'utf8'), 'sample');
const clone = p => JSON.parse(JSON.stringify(p));
const p = clone(state.project), original = clone(p), roomId = p.rooms[0].id;
const biz = { marginPct: 12, myRates: { fl_tile600: { m: 41000, l: 42000 } } };
const baseline = buildEstimate(p, { biz });
let edited = applyStudioStyle(p, roomId, 'calm');
edited = changeStudioFinish(edited, roomId, 'floor', 'fl_hardwood');
edited = changeStudioFinish(edited, roomId, 'wall', 'wl_paint', 0xe9e4dc);
assert.deepEqual(p, original, 'live changes must return a new project');
assert.deepEqual(edited.rooms.slice(1), original.rooms.slice(1), 'only chosen room changes');
const review = buildStudioReview(edited, roomId, biz);
assert.equal(review.before.total, baseline.total, 'baseline survives preset then custom changes');
assert.equal(review.current.total, buildEstimate(edited, { biz }).total);
assert.equal(review.delta, review.current.total - baseline.total);
assert.equal(review.changes.length, 3);
assert.equal(buildProposal(edited, { roomId, biz }).appliedId, null, 'custom finishes invalidate preset badge');
for (const estimate of [review.current, review.before]) {
  assert.ok(Math.abs(estimate.rows.reduce((n, x) => n + x.amount, 0) - estimate.sub) < 1e-7);
  assert.ok(Math.abs(estimate.subM + estimate.subL - estimate.sub) < 1e-7);
  assert.equal(estimate.total, estimate.sub + estimate.vat);
}
// Restoring finishes must preserve later geometry and newly imported rooms.
edited.rooms[0].pos = { x: 8, z: -3 }; edited.rooms[0].lights.push({ id: 'later', type: 'lt_down3', x: 1, z: 1 });
const restored = applyStudioStyle(edited, roomId, 'current');
assert.deepEqual(restored.rooms[0].pos, { x: 8, z: -3 });
assert.equal(restored.rooms[0].lights.at(-1).id, 'later');
assert.equal(restored.rooms[0].floorFinish, original.rooms[0].floorFinish);
// Saved/shared baseline is portable and never takes the recipient's prices.
const baked = snapshotProposalProject(edited, biz);
const shared = buildStudioReview(JSON.parse(JSON.stringify(baked)), roomId, { marginPct: 30 }, true);
assert.equal(shared.current.total, buildStudioReview(edited, roomId, biz).current.total);
assert.equal(shared.before.total, buildStudioReview(edited, roomId, biz).before.total);
// Baseline is external input: whitelist fields so it cannot replace geometry or rates.
const hostile = clone(edited);
hostile.designBaseline.rooms[roomId].plan = { poisoned: true };
hostile.designBaseline.rooms[roomId].furniture = [];
hostile.designBaseline.rooms[roomId].rates = { fl_hardwood: { m: 0, l: 0 } };
const safe = applyStudioStyle(hostile, roomId, 'current');
assert.deepEqual(safe.rooms[0].plan, edited.rooms[0].plan);
assert.deepEqual(safe.rooms[0].furniture, edited.rooms[0].furniture);
assert.equal(safe.rooms[0].rates, undefined);
assert.throws(() => changeStudioFinish(p, roomId, 'floor', 'lt_down3'), RangeError);
assert.throws(() => changeStudioFinish(p, roomId, 'wall', 'wl_paint', -1), RangeError);
assert.throws(() => changeStudioFinish(p, 'missing', 'floor', 'fl_laminate'), RangeError);
console.log('PASS studio custom finishes, persistent baseline, cost invariants, scope, restore, shared pricing, external metadata');
