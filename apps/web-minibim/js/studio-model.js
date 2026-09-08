// 작업실: 실제 방의 마감 변경과 변경 전 비교. 비교 기준은 저장·공유 가능한 마감 필드만 담는다.
import { FINISH_FLOOR, FINISH_WALL, FINISH_CEIL, item, canonId } from './catalog.js';
import { buildEstimate } from './estimate.js';
import { applyProposal } from './proposal-model.js';

export const FINISH_GROUPS = [
  { kind: 'floor', field: 'floorFinish', label: '바닥', items: FINISH_FLOOR },
  { kind: 'wall', field: 'wallFinish', label: '벽', items: FINISH_WALL },
  { kind: 'ceil', field: 'ceilFinish', label: '천장', items: FINISH_CEIL },
];
const clone = x => JSON.parse(JSON.stringify(x));
const snapshot = r => Object.fromEntries([
  ...FINISH_GROUPS.map(g => [g.field, r[g.field]]),
  ['finishColors', { ...r.finishColors }],
]);
function valid(s) {
  return s && FINISH_GROUPS.every(g => g.items.some(i => i.id === canonId(s[g.field])))
    && (!s.finishColors || (typeof s.finishColors === 'object' && !Array.isArray(s.finishColors)
      && Object.values(s.finishColors).every(c => Number.isInteger(c) && c >= 0 && c <= 0xffffff)));
}
function baseline(p, r) {
  const saved = p.designBaseline?.version === 1 && Object.hasOwn(p.designBaseline.rooms || {}, r.id)
    ? p.designBaseline.rooms[r.id] : null;
  return snapshot(valid(saved) ? saved : r);
}
function remember(original, result, roomId) {
  const r = original.rooms.find(r => r.id === roomId);
  result.designBaseline = { version: 1, rooms: { ...original.designBaseline?.rooms, [roomId]: clone(baseline(original, r)) } };
  return result;
}
function target(p, roomId) {
  const r = p?.rooms?.find(r => r.id === roomId);
  if (!r) throw new RangeError('변경할 공간을 선택하세요.');
  return r;
}
export function changeStudioFinish(project, roomId, kind, materialId, color) {
  target(project, roomId);
  const group = FINISH_GROUPS.find(g => g.kind === kind);
  if (!group || !group.items.some(i => i.id === materialId)) throw new RangeError('이 부위에 사용할 수 없는 마감입니다.');
  if (color !== undefined && (!Number.isInteger(color) || color < 0 || color > 0xffffff)) throw new RangeError('올바른 색상을 선택하세요.');
  const result = remember(project, clone(project), roomId);
  const r = target(result, roomId);
  r[group.field] = materialId;
  r.finishColors = { ...r.finishColors, [kind]: color ?? item(materialId).color };
  return result;
}
export function applyStudioStyle(project, roomId, style) {
  const r = target(project, roomId);
  if (style === 'current') {
    const result = clone(project);
    Object.assign(target(result, roomId), clone(baseline(project, r)));
    return result;
  }
  return remember(project, applyProposal(project, style, { roomId }), roomId);
}
export function buildStudioReview(project, roomId, biz = {}, customerView = false) {
  const current = buildEstimate(project, { biz, customerView });
  const r = project?.rooms?.find(r => r.id === roomId);
  if (!r) return { current, before: current, beforeProject: project, changes: [], delta: 0 };
  const beforeProject = clone(project);
  const beforeRoom = target(beforeProject, roomId);
  Object.assign(beforeRoom, clone(baseline(project, r)));
  const before = buildEstimate(beforeProject, { biz, customerView });
  const changes = FINISH_GROUPS.flatMap(g => {
    const a = item(canonId(beforeRoom[g.field])), b = item(canonId(r[g.field]));
    const colorChanged = (beforeRoom.finishColors?.[g.kind] ?? a?.color) !== (r.finishColors?.[g.kind] ?? b?.color);
    if (a?.id === b?.id && !colorChanged) return [];
    const amount = estimate => estimate.rows.filter(row => row.roomId === roomId && row.cat === g.label).reduce((sum, row) => sum + row.amount, 0);
    return [{ kind: g.kind, label: g.label, before: a?.name || '기존 마감', after: b?.name || '선택 마감', colorOnly: a?.id === b?.id, delta: amount(current) - amount(before) }];
  });
  return { current, before, beforeProject, changes, delta: current.total - before.total };
}
