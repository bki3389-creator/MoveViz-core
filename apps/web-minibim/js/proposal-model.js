// 고객 제안 — 같은 실측·수량·단가에서 마감만 바꾼 대안. 전역 프로젝트를 변경하지 않는다.
import { buildEstimate } from './estimate.js';
import { metricsOf } from './state.js';
import { item, canonId, FINISH_FLOOR, FINISH_WALL, FINISH_CEIL } from './catalog.js';

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isWet = room => /욕실|화장실|발코니|베란다/.test(room?.name || '');
const kinds = [
  { kind: 'floor', field: 'floorFinish', label: '바닥', catalog: FINISH_FLOOR },
  { kind: 'wall', field: 'wallFinish', label: '벽', catalog: FINISH_WALL },
  { kind: 'ceil', field: 'ceilFinish', label: '천장', catalog: FINISH_CEIL },
];
const STYLES = {
  current: { title: '현재 계획', description: '제안을 적용하기 전 마감과 공사 범위입니다.' },
  warm: {
    title: '따뜻한 오크', description: '오크 톤 강마루와 크림 벽지로 편안하고 온기 있는 공간을 만듭니다.',
    floorFinish: 'fl_laminate', wallFinish: 'wl_silk', ceilFinish: 'cl_silk',
    finishColors: { floor: 0xc7ad87, wall: 0xeee6d8, ceil: 0xf5f0e7 },
    finishNames: { floor: '오크 톤 강마루', wall: '크림 실크벽지', ceil: '아이보리 실크벽지' },
  },
  calm: {
    title: '차분한 미네랄', description: '밝은 포세린 바닥과 화이트 도장으로 차분하고 정돈된 공간을 만듭니다.',
    floorFinish: 'fl_tile600', wallFinish: 'wl_paint', ceilFinish: 'cl_paint',
    finishColors: { floor: 0xd3d0c8, wall: 0xf0efeb, ceil: 0xf7f6f2 },
    finishNames: { floor: '라이트 포세린 타일', wall: '웜 화이트 도장', ceil: '화이트 도장' },
  },
};

// 저장된 baseline은 마감 필드만 신뢰한다. 공유 링크의 임의 plan/단가 필드는 적용하지 않는다.
function readSnapshot(value) {
  if (!record(value)) return null;
  const result = {};
  for (const { field, catalog } of kinds) {
    if (typeof value[field] !== 'string' || !catalog.some(x => x.id === canonId(value[field]))) return null;
    result[field] = value[field];
  }
  if (Object.hasOwn(value, 'finishColors')) {
    if (!record(value.finishColors)) return null;
    result.finishColors = {};
    for (const { kind } of kinds) {
      if (!Object.hasOwn(value.finishColors, kind)) continue;
      const color = value.finishColors[kind];
      if (!Number.isInteger(color) || color < 0 || color > 0xffffff) return null;
      result.finishColors[kind] = color;
    }
  }
  return result;
}

function snapshot(room) {
  const result = {};
  for (const { field } of kinds) result[field] = room[field];
  if (record(room.finishColors)) result.finishColors = clone(room.finishColors);
  return result;
}

function setFinishes(room, value) {
  for (const { field } of kinds) room[field] = value[field];
  // 원래 색상 오버라이드가 없었다면 카탈로그 기본색으로 복원한다.
  if (Object.hasOwn(value, 'finishColors')) room.finishColors = clone(value.finishColors);
  else delete room.finishColors;
}

function sameSnapshot(a, b) {
  return kinds.every(({ field, kind }) => a[field] === b[field]
    && (a.finishColors?.[kind] ?? null) === (b.finishColors?.[kind] ?? null));
}

function roomContext(project, requestedId) {
  const rooms = Array.isArray(project?.rooms) ? project.rooms : [];
  const saved = record(project?.proposal) ? project.proposal : null;
  const room = rooms.find(r => r.id === requestedId)
    || rooms.find(r => r.id === saved?.roomId)
    || rooms.find(r => /거실/.test(r.name || ''))
    || rooms.find(r => !isWet(r))
    || rooms[0];
  if (!room) return null;
  const live = snapshot(room);
  const baseline = readSnapshot(saved?.baseline);
  const applied = readSnapshot(saved?.applied);
  const sameRoom = saved?.roomId === room.id;
  const valid = sameRoom && saved.version === 1 && baseline && applied
    && typeof saved.selectedStyle === 'string' && Object.hasOwn(STYLES, saved.selectedStyle)
    && sameSnapshot(live, applied);
  return { room, baseline: valid ? baseline : live, appliedId: valid ? saved.selectedStyle : null,
    stale: Boolean(sameRoom && !valid) };
}

function describeChanges(before, after, style, room, estimate) {
  return kinds.flatMap(({ kind, field, label }) => {
    const beforeId = canonId(before[field]), afterId = canonId(after[field]);
    const beforeColor = before.finishColors?.[kind] ?? item(beforeId)?.color;
    const afterColor = after.finishColors?.[kind] ?? item(afterId)?.color;
    if (beforeId === afterId && beforeColor === afterColor) return [];
    return [{ kind, label, beforeId, afterId, beforeColor, afterColor,
      before: item(beforeId)?.name || '현재 마감',
      after: style.finishNames?.[kind] || item(afterId)?.name || '현재 마감',
      qty: estimate.rows.filter(row => row.roomId === room.id && row.cat === label).reduce((sum, row) => sum + row.qty, 0), unit: '㎡',
      colorOnly: beforeId === afterId,
      note: kind === 'wall' && Object.keys(room.wallOverrides || {}).length ? '개별 지정 벽의 마감은 유지' : '',
    }];
  });
}

/** 제안 비교. biz를 생략하면 프로젝트에 저장된 단가/이윤만 사용한다. */
export function buildProposal(project, { roomId, biz = {}, customerView = false } = {}) {
  const context = roomContext(project, roomId);
  if (!context) return { roomId: null, roomName: '', area: 0, baseline: null, options: [], selectedId: null, appliedId: null, stale: false, eligible: false };
  const { room, baseline, appliedId, stale } = context;
  const eligible = !isWet(room);
  const options = Object.entries(STYLES).filter(([id]) => eligible || id === 'current').map(([id, style]) => {
    const candidate = clone(project);
    const candidateRoom = candidate.rooms.find(r => r.id === room.id);
    setFinishes(candidateRoom, id === 'current' ? baseline : style);
    const estimate = buildEstimate(candidate, { biz, customerView });
    const roomSubtotal = estimate.rows.filter(row => row.roomId === room.id).reduce((sum, row) => sum + row.amount, 0);
    return { id, title: style.title, description: style.description, project: candidate, estimate,
      delta: 0, roomSubtotal,
      changes: id === 'current' ? [] : describeChanges(baseline, candidateRoom, style, candidateRoom, estimate),
      palette: kinds.map(({ kind, field }) => candidateRoom.finishColors?.[kind] ?? item(canonId(candidateRoom[field]))?.color ?? 0xdddddd),
    };
  });
  for (const option of options) option.delta = option.estimate.total - options[0].estimate.total;
  return { roomId: room.id, roomName: room.name || '공간', area: metricsOf(room, project).area,
    baseline: options[0], options, selectedId: eligible ? appliedId || 'warm' : 'current', appliedId, stale, eligible };
}

/** 마감 적용/현재 계획 복원. 저장 기준은 마감뿐이므로 그 사이의 구조·가구·조명 편집은 유지된다. */
export function applyProposal(project, optionId, { roomId } = {}) {
  if (!Object.hasOwn(STYLES, optionId)) throw new RangeError('알 수 없는 제안입니다.');
  const result = clone(project);
  const context = roomContext(project, roomId);
  if (!context) return result;
  if (optionId !== 'current' && isWet(context.room)) throw new RangeError('이 마감 제안은 거실·침실 등 건식 공간에 적용할 수 있습니다.');
  const target = result.rooms.find(r => r.id === context.room.id);
  setFinishes(target, optionId === 'current' ? context.baseline : STYLES[optionId]);
  result.proposal = {
    version: 1, roomId: context.room.id, selectedStyle: optionId,
    baseline: clone(context.baseline), applied: snapshot(target),
  };
  return result;
}

/** 저장/공유 직전 유효 단가를 고정. 현장 0% 이윤도 회사 기본값보다 우선한다. */
export function snapshotProposalProject(project, biz = {}) {
  const result = clone(project);
  if (!record(result)) return result;
  result.rates = { ...(record(biz?.myRates) ? clone(biz.myRates) : {}), ...(record(result.rates) ? result.rates : {}) };
  result.marginPct = Number(result.marginPct ?? biz?.marginPct) || 0;
  return result;
}
