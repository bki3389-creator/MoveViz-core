// catalog.js — 미니BIM 유형·재료·조명 카탈로그 (RhinoBIM의 "부재=유형+파라미터" 개념의 웹판)
// 단가는 ⚠️ 참고값(재료+시공 개략, 2026 수도권) — 우측 패널에서 수정, 프로젝트 JSON에 저장됨.
// unit: 'm2' 면적 / 'm' 길이 / 'ea' 개소. qty: 어떤 실측 수량에 곱하는지.

export const FINISH_FLOOR = [
  { id: 'fl_keep',     name: '기존 유지',          spec: '-',            unit: 'm2', rate: 0,       color: 0xb9a98c },
  { id: 'fl_laminate', name: '강마루',             spec: '7.5T',         unit: 'm2', rate: 55000,   color: 0xc8a878 },
  { id: 'fl_hardwood', name: '원목마루',           spec: '15T',          unit: 'm2', rate: 120000,  color: 0xa8794f },
  { id: 'fl_sheet',    name: '장판(모노륨)',       spec: '1.8T',         unit: 'm2', rate: 15000,   color: 0xd8c9a8 },
  { id: 'fl_tile600',  name: '포세린 타일',        spec: '600×600',      unit: 'm2', rate: 75000,   color: 0xcfcfca },
  { id: 'fl_tile300',  name: '바닥 타일(욕실)',    spec: '300×300',      unit: 'm2', rate: 65000,   color: 0xb8bcc0 },
];

export const FINISH_WALL = [
  { id: 'wl_keep',   name: '기존 유지',        spec: '-',          unit: 'm2', rate: 0,      color: 0xdedad2 },
  { id: 'wl_silk',   name: '실크벽지',         spec: '광폭',        unit: 'm2', rate: 12000,  color: 0xefeae0 },
  { id: 'wl_paper',  name: '합지벽지',         spec: '소폭 2겹',    unit: 'm2', rate: 7000,   color: 0xe9e2d4 },
  { id: 'wl_paint',  name: '페인트',           spec: '친환경 2회',  unit: 'm2', rate: 18000,  color: 0xe4e7e2 },
  { id: 'wl_film',   name: '인테리어 필름',    spec: '샌딩+시공',   unit: 'm2', rate: 25000,  color: 0xd6cec2 },
  { id: 'wl_tile',   name: '벽 타일',          spec: '300×600',    unit: 'm2', rate: 90000,  color: 0xc3ccd1 },
  { id: 'wl_wood',   name: '목재 루버',        spec: '히노키 무절', unit: 'm2', rate: 80000,  color: 0xb08a5e },
];

export const FINISH_CEIL = [
  { id: 'cl_keep',  name: '기존 유지',  spec: '-',         unit: 'm2', rate: 0,     color: 0xf2efe9 },
  { id: 'cl_silk',  name: '실크벽지',   spec: '광폭',       unit: 'm2', rate: 12000, color: 0xf4f1ea },
  { id: 'cl_paint', name: '페인트',     spec: '친환경 2회', unit: 'm2', rate: 20000, color: 0xf0f2f0 },
];

// 천장 유형 — 목공 구조. basis: 'area'(바닥면적) | 'perimeter'(둘레)
export const CEIL_TYPES = [
  { id: 'ct_keep',     name: '기존 천장 유지',      spec: '-',                    basis: 'area',      unit: 'm2', rate: 0 },
  { id: 'ct_flat',     name: '평천장 재시공',       spec: '석고 1P·목틀',          basis: 'area',      unit: 'm2', rate: 45000 },
  { id: 'ct_well',     name: '우물천장',            spec: '단내림 150·간접 홈',     basis: 'area',      unit: 'm2', rate: 65000 },
  { id: 'ct_indirect', name: '간접등 박스(커튼박스)', spec: '둘레 목공',            basis: 'perimeter', unit: 'm',  rate: 45000 },
  { id: 'ct_exposed',  name: '노출천장',            spec: '철거+도장',             basis: 'area',      unit: 'm2', rate: 55000 },
];

// 벽체 유형 — 벽별 지정. basis: 'wallArea'(해당 벽 순면적)
export const WALL_TYPES = [
  { id: 'wt_keep', name: '기존벽 (마감만)',   spec: '-',            unit: 'm2', rate: 0 },
  { id: 'wt_stud', name: '경량 가벽 신설',    spec: '스터드+석고2P', unit: 'm2', rate: 90000 },
  { id: 'wt_wood', name: '목공 가벽 신설',    spec: '목틀+석고2P',   unit: 'm2', rate: 120000 },
  { id: 'wt_demo', name: '벽 철거',           spec: '비내력 확인',   unit: 'm2', rate: 30000 },
];

// 조명 — kind: 'point'(개소) | 'line'(2점 길이). y: 천장 부착.
export const LIGHTS = [
  { id: 'lt_down3',   name: '다운라이트 3"',   spec: 'COB 8W',        kind: 'point', unit: 'ea', rate: 25000,  color: 0xfff2d0, watt: 8 },
  { id: 'lt_down6',   name: '매입등 6"',       spec: 'LED 15W',       kind: 'point', unit: 'ea', rate: 30000,  color: 0xfff6dd, watt: 15 },
  { id: 'lt_pendant', name: '펜던트',          spec: '식탁·포인트',    kind: 'point', unit: 'ea', rate: 120000, color: 0xffe9b8, watt: 12 },
  { id: 'lt_ceilfan', name: '실링팬 조명',     spec: '52"',           kind: 'point', unit: 'ea', rate: 250000, color: 0xf2f2f2, watt: 20 },
  { id: 'lt_line',    name: 'T5 라인조명',     spec: '알루미늄 매입',  kind: 'line',  unit: 'm',  rate: 35000,  color: 0xfff8e0, watt: 10 },
  { id: 'lt_mag',     name: '마그네틱 트랙',   spec: '매입 트랙+모듈', kind: 'line',  unit: 'm',  rate: 150000, color: 0xdde6ff, watt: 15 },
];

// 부자재(자동 산출) — 걸레받이·몰딩
export const TRIMS = [
  { id: 'tr_base', name: '걸레받이', spec: 'H80',        unit: 'm', rate: 6000 },
  { id: 'tr_mold', name: '천장 몰딩', spec: '마이너스/평', unit: 'm', rate: 7000 },
];

export const ALL_RATED = [...FINISH_FLOOR, ...FINISH_WALL, ...FINISH_CEIL, ...CEIL_TYPES, ...WALL_TYPES, ...LIGHTS, ...TRIMS];

const _byId = new Map(ALL_RATED.map(e => [e.id, e]));
export function item(id) { return _byId.get(id); }
export function rateOf(id, rates) { const o = rates && rates[id]; return (o === 0 || o) ? o : (item(id)?.rate ?? 0); }
export const KRW = v => (v || 0).toLocaleString('ko-KR');

// 가구 카탈로그 (배치용, m) — iOS FurnitureCatalog 축약판
export const FURN_ITEMS = [
  { name: '침대 Q', category: 'bed', w: 1.5, d: 2.0 },
  { name: '침대 SS', category: 'bed', w: 1.1, d: 2.0 },
  { name: '소파 3인', category: 'sofa', w: 2.0, d: 0.9 },
  { name: '소파 2인', category: 'sofa', w: 1.5, d: 0.9 },
  { name: '식탁 4인', category: 'table', w: 1.2, d: 0.8 },
  { name: '식탁 6인', category: 'table', w: 1.8, d: 0.9 },
  { name: '책상 1200', category: 'table', w: 1.2, d: 0.6 },
  { name: '의자', category: 'chair', w: 0.45, d: 0.5 },
  { name: '옷장 1200', category: 'cabinet', w: 1.2, d: 0.6 },
  { name: '붙박이장 2400', category: 'cabinet', w: 2.4, d: 0.6 },
  { name: 'TV장 1800', category: 'cabinet', w: 1.8, d: 0.4 },
  { name: '냉장고', category: 'refrigerator', w: 0.9, d: 0.8 },
  { name: '세탁기', category: 'appliance', w: 0.6, d: 0.65 },
  { name: '변기', category: 'toilet', w: 0.4, d: 0.7 },
  { name: '세면대', category: 'sink', w: 0.6, d: 0.45 },
  { name: '욕조 1500', category: 'bathtub', w: 1.5, d: 0.75 },
];
