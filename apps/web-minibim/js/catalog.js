// catalog.js — 미니BIM 유형·재료 카탈로그 v2 (재료비/노무비 분리, 원/단위)
// ⚠️ 단가는 참고값(2026 수도권 개략) — 견적표에서 수정하면 프로젝트에 저장된다.
// unit: 'm2' | 'm' | 'ea' | 'sik'(식). 리서치 결과로 계속 보강.

export const FINISH_FLOOR = [
  { id: 'fl_keep',      name: '기존 유지',        spec: '-',           unit: 'm2', mat: 0,      lab: 0,     color: 0xb9a98c },
  { id: 'fl_laminate',  name: '강마루',           spec: '7.5T',        unit: 'm2', mat: 38000,  lab: 17000, color: 0xc8a878 },
  { id: 'fl_lamin12',   name: '강화마루',         spec: '12T',         unit: 'm2', mat: 25000,  lab: 13000, color: 0xd0b088 },
  { id: 'fl_ondol',     name: '온돌마루(합판)',   spec: '7.5T',        unit: 'm2', mat: 45000,  lab: 18000, color: 0xbf9668 },
  { id: 'fl_hardwood',  name: '원목마루',         spec: '15T',         unit: 'm2', mat: 90000,  lab: 30000, color: 0xa8794f },
  { id: 'fl_herring',   name: '헤링본 마루',      spec: '강마루 헤링본', unit: 'm2', mat: 48000,  lab: 32000, color: 0xb98e5e },
  { id: 'fl_sheet18',   name: '장판(모노륨)',     spec: '1.8T',        unit: 'm2', mat: 9000,   lab: 6000,  color: 0xd8c9a8 },
  { id: 'fl_sheet45',   name: '장판(두꺼운)',     spec: '4.5T',        unit: 'm2', mat: 22000,  lab: 8000,  color: 0xd2c29e },
  { id: 'fl_decotile',  name: '데코타일',         spec: '3T 사각/우드', unit: 'm2', mat: 15000,  lab: 12000, color: 0xc4b598 },
  { id: 'fl_tile600',   name: '포세린 타일',      spec: '600×600',     unit: 'm2', mat: 35000,  lab: 40000, color: 0xcfcfca },
  { id: 'fl_tile300',   name: '바닥 타일(욕실)',  spec: '300×300',     unit: 'm2', mat: 28000,  lab: 37000, color: 0xb8bcc0 },
  { id: 'fl_polish',    name: '폴리싱 타일',      spec: '800×800 유광', unit: 'm2', mat: 45000,  lab: 45000, color: 0xe3e3df },
];

export const FINISH_WALL = [
  { id: 'wl_keep',    name: '기존 유지',       spec: '-',            unit: 'm2', mat: 0,     lab: 0,     color: 0xdedad2 },
  { id: 'wl_silk',    name: '실크벽지',        spec: '광폭',          unit: 'm2', mat: 4500,  lab: 7500,  color: 0xefeae0 },
  { id: 'wl_paper',   name: '합지벽지',        spec: '소폭 2겹',      unit: 'm2', mat: 2500,  lab: 4500,  color: 0xe9e2d4 },
  { id: 'wl_mural',   name: '뮤럴/포인트 벽지', spec: '수입·디자인',   unit: 'm2', mat: 18000, lab: 9000,  color: 0xd9cfc4 },
  { id: 'wl_paint',   name: '페인트',          spec: '친환경 2회',    unit: 'm2', mat: 5000,  lab: 13000, color: 0xdde5da },
  { id: 'wl_venpaint',name: '수입 페인트',     spec: '벤자민무어급',   unit: 'm2', mat: 12000, lab: 16000, color: 0xd4dde2 },
  { id: 'wl_film',    name: '인테리어 필름',   spec: '샌딩+시공',     unit: 'm2', mat: 8000,  lab: 17000, color: 0xd6cec2 },
  { id: 'wl_tile',    name: '벽 타일',         spec: '300×600',      unit: 'm2', mat: 40000, lab: 50000, color: 0xaebfca },
  { id: 'wl_brick',   name: '파벽돌',          spec: '접착식',        unit: 'm2', mat: 35000, lab: 40000, color: 0xb2867a },
  { id: 'wl_stone',   name: '대리석/세라믹 아트월', spec: '600각 이상', unit: 'm2', mat: 90000, lab: 60000, color: 0xcac6bd },
  { id: 'wl_wains',   name: '웨인스코팅',      spec: '몰딩+도장',     unit: 'm2', mat: 25000, lab: 35000, color: 0xe6e2d8 },
  { id: 'wl_wood',    name: '목재 루버',       spec: '히노키 무절',   unit: 'm2', mat: 45000, lab: 35000, color: 0xb08a5e },
];

export const FINISH_CEIL = [
  { id: 'cl_keep',  name: '기존 유지', spec: '-',          unit: 'm2', mat: 0,     lab: 0,     color: 0xf2efe9 },
  { id: 'cl_silk',  name: '실크벽지',  spec: '광폭',        unit: 'm2', mat: 4500,  lab: 7500,  color: 0xf4f1ea },
  { id: 'cl_paper', name: '합지벽지',  spec: '소폭',        unit: 'm2', mat: 2500,  lab: 4500,  color: 0xf2efe7 },
  { id: 'cl_paint', name: '페인트',    spec: '친환경 2회',  unit: 'm2', mat: 5000,  lab: 15000, color: 0xf0f2f0 },
  { id: 'cl_sgb',   name: 'SMC/돔천장(욕실)', spec: '욕실용', unit: 'm2', mat: 25000, lab: 20000, color: 0xf5f7f7 },
];

export const CEIL_TYPES = [
  { id: 'ct_keep',     name: '기존 천장 유지',        spec: '-',                basis: 'area',      unit: 'm2', mat: 0,     lab: 0 },
  { id: 'ct_flat',     name: '평천장 재시공',         spec: '석고 1P·목틀',      basis: 'area',      unit: 'm2', mat: 20000, lab: 25000 },
  { id: 'ct_well',     name: '우물천장',              spec: '단내림 150·간접홈', basis: 'area',      unit: 'm2', mat: 30000, lab: 35000 },
  { id: 'ct_indirect', name: '간접등 박스(커튼박스)', spec: '둘레 목공',         basis: 'perimeter', unit: 'm',  mat: 18000, lab: 27000 },
  { id: 'ct_nomold',   name: '무몰딩 마감',           spec: '천장-벽 민몰딩',    basis: 'perimeter', unit: 'm',  mat: 8000,  lab: 17000 },
  { id: 'ct_exposed',  name: '노출천장',              spec: '철거+도장',         basis: 'area',      unit: 'm2', mat: 15000, lab: 40000 },
];

export const WALL_TYPES = [
  { id: 'wt_keep', name: '기존벽 (마감만)', spec: '-',            unit: 'm2', mat: 0,     lab: 0 },
  { id: 'wt_stud', name: '경량 가벽 신설',  spec: '스터드+석고2P', unit: 'm2', mat: 40000, lab: 50000 },
  { id: 'wt_wood', name: '목공 가벽 신설',  spec: '목틀+석고2P',   unit: 'm2', mat: 55000, lab: 65000 },
  { id: 'wt_glass',name: '유리 파티션',     spec: '강화 12T·프레임', unit: 'm2', mat: 120000, lab: 60000 },
  { id: 'wt_demo', name: '벽 철거',         spec: '비내력·폐기물', unit: 'm2', mat: 5000,  lab: 25000 },
];

export const LIGHTS = [
  { id: 'lt_down3',   name: '다운라이트 3"', spec: 'COB 8W',         kind: 'point', unit: 'ea', mat: 12000,  lab: 13000, color: 0xfff2d0, watt: 8 },
  { id: 'lt_down6',   name: '매입등 6"',     spec: 'LED 15W',        kind: 'point', unit: 'ea', mat: 15000,  lab: 15000, color: 0xfff6dd, watt: 15 },
  { id: 'lt_edge',    name: '엣지등(면조명)', spec: '520×320',        kind: 'point', unit: 'ea', mat: 35000,  lab: 20000, color: 0xffffff, watt: 25 },
  { id: 'lt_pendant', name: '펜던트',        spec: '식탁·포인트',     kind: 'point', unit: 'ea', mat: 90000,  lab: 30000, color: 0xffe9b8, watt: 12 },
  { id: 'lt_ceilfan', name: '실링팬 조명',   spec: '52"',            kind: 'point', unit: 'ea', mat: 200000, lab: 50000, color: 0xf2f2f2, watt: 20 },
  { id: 'lt_sensor',  name: '센서등(현관)',  spec: 'LED 15W',        kind: 'point', unit: 'ea', mat: 18000,  lab: 12000, color: 0xfff6dd, watt: 15 },
  { id: 'lt_line',    name: 'T5 라인조명',   spec: '알루미늄 매입',   kind: 'line',  unit: 'm',  mat: 18000,  lab: 17000, color: 0xfff8e0, watt: 10 },
  { id: 'lt_indT5',   name: '간접조명 T5',   spec: '우물/커튼박스용', kind: 'line',  unit: 'm',  mat: 9000,   lab: 9000,  color: 0xfff3d6, watt: 8 },
  { id: 'lt_mag',     name: '마그네틱 트랙', spec: '매입 트랙+모듈',  kind: 'line',  unit: 'm',  mat: 110000, lab: 40000, color: 0xdde6ff, watt: 15 },
];

export const TRIMS = [
  { id: 'tr_base', name: '걸레받이',  spec: 'H80',        unit: 'm', mat: 3000, lab: 3000 },
  { id: 'tr_mold', name: '천장 몰딩', spec: '마이너스/평', unit: 'm', mat: 3500, lab: 3500 },
];

// 실별 "추가 공사" — 창호·문·주방·욕실·전기·설비 등 개소/식 항목 (인스펙터에서 추가)
export const EXTRA_ITEMS = [
  // 창호
  { id: 'ex_sash_bal',  group: '창호', name: '발코니 샷시 교체',  spec: '이중창 PVC',    unit: 'm2', mat: 250000, lab: 60000 },
  { id: 'ex_sash_in',   group: '창호', name: '내창 교체',         spec: '단창 PVC',      unit: 'm2', mat: 180000, lab: 50000 },
  { id: 'ex_glass',     group: '창호', name: '유리만 교체',       spec: '복층 24T',      unit: 'm2', mat: 70000,  lab: 40000 },
  { id: 'ex_sash_film', group: '창호', name: '샷시 필름 랩핑',    spec: '창틀 필름',      unit: 'ea', mat: 60000,  lab: 90000 },
  // 문
  { id: 'ex_door',      group: '문',   name: '방문 교체',         spec: 'ABS+문틀 랩핑',  unit: 'ea', mat: 280000, lab: 120000 },
  { id: 'ex_doorpaint', group: '문',   name: '방문 도장/필름',    spec: '문+문틀',        unit: 'ea', mat: 60000,  lab: 90000 },
  { id: 'ex_sliding',   group: '문',   name: '슬라이딩 도어',     spec: '3연동 중문',     unit: 'ea', mat: 900000, lab: 300000 },
  { id: 'ex_handle',    group: '문',   name: '도어 손잡이 교체',  spec: '레버형',         unit: 'ea', mat: 25000,  lab: 15000 },
  // 현관/수납
  { id: 'ex_entrance',  group: '현관', name: '현관 타일 덧방',    spec: '600각',          unit: 'sik', mat: 150000, lab: 150000 },
  { id: 'ex_shoecab',   group: '현관', name: '신발장 제작',       spec: '폭 m당',         unit: 'm',  mat: 250000, lab: 100000 },
  { id: 'ex_builtin',   group: '수납', name: '붙박이장 제작',     spec: '폭 m당·천장고',   unit: 'm',  mat: 350000, lab: 150000 },
  // 주방
  { id: 'ex_kitchen',   group: '주방', name: '싱크대 상하부장',   spec: 'PET·폭 m당',     unit: 'm',  mat: 450000, lab: 150000 },
  { id: 'ex_counter',   group: '주방', name: '상판 교체',         spec: '칸스톤 m당',     unit: 'm',  mat: 250000, lab: 80000 },
  { id: 'ex_sinkbowl',  group: '주방', name: '씽크볼+수전',       spec: '사각 대형',      unit: 'sik', mat: 350000, lab: 100000 },
  { id: 'ex_hood',      group: '주방', name: '후드 교체',         spec: '침니형',         unit: 'ea', mat: 250000, lab: 60000 },
  { id: 'ex_cooktop',   group: '주방', name: '쿡탑 교체',         spec: '인덕션 3구',     unit: 'ea', mat: 600000, lab: 80000 },
  // 욕실
  { id: 'ex_toilet',    group: '욕실', name: '양변기 교체',       spec: '투피스·부속',    unit: 'ea', mat: 250000, lab: 80000 },
  { id: 'ex_basin',     group: '욕실', name: '세면대 교체',       spec: '반다리+수전',    unit: 'ea', mat: 200000, lab: 80000 },
  { id: 'ex_shower',    group: '욕실', name: '샤워부스/파티션',   spec: '강화유리',       unit: 'sik', mat: 450000, lab: 150000 },
  { id: 'ex_bathacc',   group: '욕실', name: '욕실 악세서리',     spec: '수건걸이 등 세트', unit: 'sik', mat: 120000, lab: 50000 },
  { id: 'ex_waterproof',group: '욕실', name: '방수 공사',         spec: '바닥+벽 1m',     unit: 'sik', mat: 150000, lab: 250000 },
  // 전기/설비
  { id: 'ex_switch',    group: '전기', name: '스위치·콘센트 교체', spec: '개당',           unit: 'ea', mat: 8000,   lab: 12000 },
  { id: 'ex_wiring',    group: '전기', name: '전기 배선 증설',    spec: '회로당',         unit: 'ea', mat: 40000,  lab: 80000 },
  { id: 'ex_boiler',    group: '설비', name: '보일러 교체',       spec: '콘덴싱 20평형',   unit: 'ea', mat: 900000, lab: 200000 },
  { id: 'ex_aircon',    group: '설비', name: '에어컨 매립배관',   spec: '실당',           unit: 'ea', mat: 150000, lab: 200000 },
  // 발코니/공통
  { id: 'ex_elastic',   group: '발코니', name: '탄성코트',        spec: '발코니 1개소',   unit: 'sik', mat: 120000, lab: 180000 },
  { id: 'ex_expand',    group: '발코니', name: '발코니 확장 마감', spec: '단열+바닥',      unit: 'm2', mat: 150000, lab: 150000 },
  { id: 'ex_demolition',group: '공통', name: '철거·폐기물',       spec: '실 단위',        unit: 'sik', mat: 100000, lab: 300000 },
  { id: 'ex_cleaning',  group: '공통', name: '입주 청소',         spec: '평당',           unit: 'ea', mat: 0,      lab: 15000 },
];

export const ALL_RATED = [...FINISH_FLOOR, ...FINISH_WALL, ...FINISH_CEIL, ...CEIL_TYPES,
                          ...WALL_TYPES, ...LIGHTS, ...TRIMS, ...EXTRA_ITEMS];

const _byId = new Map(ALL_RATED.map(e => [e.id, e]));
export function item(id) { return _byId.get(id); }

/// 재료/노무 단가 — overrides(project.rates)는 {m,l} 또는 (구버전) 합계 숫자.
export function ratesOf(id, overrides) {
  const base = item(id) || { mat: 0, lab: 0 };
  const ov = overrides?.[id];
  if (ov == null) return { m: base.mat ?? 0, l: base.lab ?? 0 };
  if (typeof ov === 'number') {
    const t = (base.mat ?? 0) + (base.lab ?? 0);
    const fm = t > 0 ? (base.mat ?? 0) / t : 0.5;
    return { m: Math.round(ov * fm), l: Math.round(ov * (1 - fm)) };
  }
  return { m: ov.m ?? base.mat ?? 0, l: ov.l ?? base.lab ?? 0 };
}
export function rateOf(id, overrides) { const r = ratesOf(id, overrides); return r.m + r.l; }
export const KRW = v => (v || 0).toLocaleString('ko-KR');
export const unitKo2 = u => u === 'm2' ? '㎡' : u === 'm' ? 'm' : u === 'sik' ? '식' : '개';

// 구버전 프로젝트 호환: 삭제/개명된 마감 id → 근접 id
export const LEGACY_IDS = { fl_sheet: 'fl_sheet18' };
export function canonId(id) { return LEGACY_IDS[id] || id; }

// 가구 카탈로그 (배치용, m)
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
