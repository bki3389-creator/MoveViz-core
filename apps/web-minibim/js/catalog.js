// catalog.js — 미니BIM 카탈로그 v3
// ① 마감(바닥/벽/천장 셀렉트) + 천장/벽체 유형 + 조명 + 부자재
// ② 공사 항목(WORK_ITEMS) 75항목 체계 — 리서치_260902 설계문서 기반:
//    그룹 14공종 · 등급 3단(보급/중급/브랜드) · 자동 수량 규칙(auto) · 연동 규칙(deps)
// 단가 = 재료비(mat)/노무비(lab) 분리, 원/단위 — 2025-26 공표노임+시장 실세 리서치 중간값.
// ⚠️ 여전히 참고값: 견적표에서 수정하면 프로젝트에 저장된다. 지방 −10%, 서울 핵심권 +10~20%.

// ── 마감 (실별 셀렉트) — 단가: 리서치 보정판 ──────────────────────────

export const FINISH_FLOOR = [
  { id: 'fl_keep',      name: '기존 유지',        spec: '-',            unit: 'm2', mat: 0,     lab: 0,     color: 0xb9a98c },
  { id: 'fl_laminate',  name: '강마루',           spec: '7.5T 보급',     unit: 'm2', mat: 25000, lab: 11000, color: 0xc8a878 },
  { id: 'fl_lamin12',   name: '강화마루',         spec: '8~12T 클릭',    unit: 'm2', mat: 17000, lab: 7000,  color: 0xd0b088 },
  { id: 'fl_ondol',     name: '온돌마루(합판)',   spec: '7.5T',         unit: 'm2', mat: 33000, lab: 12000, color: 0xbf9668 },
  { id: 'fl_hardwood',  name: '원목마루',         spec: '3T 원목',       unit: 'm2', mat: 75000, lab: 15000, color: 0xa8794f },
  { id: 'fl_herring',   name: '헤링본 마루',      spec: '강마루 헤링본',  unit: 'm2', mat: 27000, lab: 20000, color: 0xb98e5e },
  { id: 'fl_sheet18',   name: '장판(모노륨)',     spec: '1.8~2.2T',     unit: 'm2', mat: 8000,  lab: 7000,  color: 0xd8c9a8 },
  { id: 'fl_sheet45',   name: '장판(층간소음)',   spec: '4.5T',         unit: 'm2', mat: 22000, lab: 11000, color: 0xd2c29e },
  { id: 'fl_decotile',  name: '데코타일',         spec: '3T 사각/우드',  unit: 'm2', mat: 14000, lab: 12000, color: 0xc4b598 },
  { id: 'fl_tile600',   name: '포세린 타일',      spec: '600각 무광',    unit: 'm2', mat: 22000, lab: 40000, color: 0xcfcfca },
  { id: 'fl_tile300',   name: '바닥 타일(욕실)',  spec: '300각 논슬립 덧방', unit: 'm2', mat: 18000, lab: 35000, color: 0xb8bcc0 },
  { id: 'fl_polish',    name: '폴리싱 타일',      spec: '800각 유광',    unit: 'm2', mat: 35000, lab: 50000, color: 0xe3e3df },
];

export const FINISH_WALL = [
  { id: 'wl_keep',    name: '기존 유지',       spec: '-',            unit: 'm2', mat: 0,     lab: 0,     color: 0xdedad2 },
  { id: 'wl_silk',    name: '실크벽지',        spec: '광폭',          unit: 'm2', mat: 2500,  lab: 5500,  color: 0xefeae0 },
  { id: 'wl_paper',   name: '합지벽지',        spec: '광폭 합지',     unit: 'm2', mat: 1500,  lab: 3500,  color: 0xe9e2d4 },
  { id: 'wl_mural',   name: '뮤럴/수입 벽지',  spec: '포인트',        unit: 'm2', mat: 12000, lab: 6000,  color: 0xd9cfc4 },
  { id: 'wl_paint',   name: '페인트',          spec: '수성 2회+줄퍼티', unit: 'm2', mat: 4000,  lab: 16000, color: 0xdde5da },
  { id: 'wl_venpaint',name: '수입 페인트',     spec: '벤자민무어급·올퍼티', unit: 'm2', mat: 8000, lab: 22000, color: 0xd4dde2 },
  { id: 'wl_film',    name: '인테리어 필름',   spec: '샌딩+시공',     unit: 'm2', mat: 10000, lab: 33000, color: 0xd6cec2 },
  { id: 'wl_tile',    name: '벽 타일(덧방)',   spec: '300×600 도기질', unit: 'm2', mat: 25000, lab: 40000, color: 0xaebfca },
  { id: 'wl_brick',   name: '파벽돌',          spec: '접착식',        unit: 'm2', mat: 30000, lab: 38000, color: 0xb2867a },
  { id: 'wl_stone',   name: '대형 세라믹/스톤', spec: '600각 이상',    unit: 'm2', mat: 80000, lab: 55000, color: 0xcac6bd },
  { id: 'wl_wains',   name: '웨인스코팅',      spec: '몰딩+도장',     unit: 'm2', mat: 20000, lab: 35000, color: 0xe6e2d8 },
  { id: 'wl_wood',    name: '목재 루버',       spec: '히노키 무절',   unit: 'm2', mat: 42000, lab: 33000, color: 0xb08a5e },
];

export const FINISH_CEIL = [
  { id: 'cl_keep',  name: '기존 유지', spec: '-',            unit: 'm2', mat: 0,    lab: 0,     color: 0xf2efe9 },
  { id: 'cl_silk',  name: '실크벽지',  spec: '광폭',          unit: 'm2', mat: 2500, lab: 5500,  color: 0xf4f1ea },
  { id: 'cl_paper', name: '합지벽지',  spec: '광폭',          unit: 'm2', mat: 1500, lab: 3500,  color: 0xf2efe7 },
  { id: 'cl_paint', name: '페인트',    spec: '수성 2회',      unit: 'm2', mat: 4000, lab: 17000, color: 0xf0f2f0 },
  { id: 'cl_sgb',   name: 'SMC 돔천장(욕실)', spec: '점검구 포함', unit: 'm2', mat: 22000, lab: 25000, color: 0xf5f7f7 },
];

export const CEIL_TYPES = [
  { id: 'ct_keep',     name: '기존 천장 유지',        spec: '-',                basis: 'area',      unit: 'm2', mat: 0,     lab: 0 },
  { id: 'ct_flat',     name: '평천장 재시공',         spec: '목틀+석고 1P',      basis: 'area',      unit: 'm2', mat: 12000, lab: 30000 },
  { id: 'ct_well',     name: '우물천장',              spec: '단내림·간접홈',     basis: 'area',      unit: 'm2', mat: 14000, lab: 34000 },
  { id: 'ct_indirect', name: '간접등 박스(커튼박스)', spec: '둘레 목공',         basis: 'perimeter', unit: 'm',  mat: 18000, lab: 42000 },
  { id: 'ct_nomold',   name: '무몰딩 마감',           spec: '마이너스/민몰딩',   basis: 'perimeter', unit: 'm',  mat: 6000,  lab: 18000 },
  { id: 'ct_exposed',  name: '노출천장',              spec: '철거+도장',         basis: 'area',      unit: 'm2', mat: 10000, lab: 40000 },
];

export const WALL_TYPES = [
  { id: 'wt_keep', name: '기존벽 (마감만)', spec: '-',              unit: 'm2', mat: 0,     lab: 0 },
  { id: 'wt_stud', name: '경량 가벽 신설',  spec: '스터드+석고 2P',  unit: 'm2', mat: 20000, lab: 40000 },
  { id: 'wt_wood', name: '목공 가벽 신설',  spec: '목틀+석고 2P',    unit: 'm2', mat: 28000, lab: 52000 },
  { id: 'wt_glass',name: '유리 파티션',     spec: '강화 12T+프레임', unit: 'm2', mat: 90000, lab: 40000 },
  { id: 'wt_demo', name: '벽 철거',         spec: '비내력+폐기물',   unit: 'm2', mat: 5000,  lab: 60000 },
];

export const LIGHTS = [
  { id: 'lt_down3',   name: '다운라이트 3"', spec: 'COB·타공+결선',   kind: 'point', unit: 'ea', mat: 18000,  lab: 17000, color: 0xfff2d0, watt: 8 },
  { id: 'lt_down6',   name: '매입등 6"',     spec: 'LED 15W',        kind: 'point', unit: 'ea', mat: 25000,  lab: 20000, color: 0xfff6dd, watt: 15 },
  { id: 'lt_edge',    name: '엣지등(면조명)', spec: '520×320',        kind: 'point', unit: 'ea', mat: 40000,  lab: 25000, color: 0xffffff, watt: 25 },
  { id: 'lt_pendant', name: '펜던트',        spec: '식탁·포인트',     kind: 'point', unit: 'ea', mat: 90000,  lab: 50000, color: 0xffe9b8, watt: 12 },
  { id: 'lt_ceilfan', name: '실링팬 조명',   spec: '52"',            kind: 'point', unit: 'ea', mat: 200000, lab: 60000, color: 0xf2f2f2, watt: 20 },
  { id: 'lt_sensor',  name: '센서등(현관)',  spec: 'LED 15W',        kind: 'point', unit: 'ea', mat: 20000,  lab: 15000, color: 0xfff6dd, watt: 15 },
  { id: 'lt_line',    name: '라인조명(매입)', spec: '알루미늄 프로파일', kind: 'line', unit: 'm', mat: 45000,  lab: 70000, color: 0xfff8e0, watt: 10 },
  { id: 'lt_indT5',   name: '간접조명 T5',   spec: '우물/커튼박스용',  kind: 'line',  unit: 'm',  mat: 12000,  lab: 12000, color: 0xfff3d6, watt: 8 },
  { id: 'lt_mag',     name: '마그네틱 트랙', spec: '매입 트랙+모듈',   kind: 'line',  unit: 'm',  mat: 120000, lab: 50000, color: 0xdde6ff, watt: 15 },
];

export const TRIMS = [
  { id: 'tr_base', name: '걸레받이',  spec: 'MDF 래핑 H80', unit: 'm', mat: 3000, lab: 5000 },
  { id: 'tr_mold', name: '천장 몰딩', spec: '평몰딩',        unit: 'm', mat: 3000, lab: 6000 },
];

// ── 공사 항목 (WORK) — 75항목 체계 ─────────────────────────────────
// auto.basis: A_floor(바닥㎡)·A_wall(벽순면적㎡)·P(둘레m)·P_door(둘레−문폭)·
//             N_door(문개소)·N_win(창개소)·A_win(창면적㎡)·room(실당 1)·manual
// auto.roomType: 해당 실 용도에만 자동 제안 (욕실/현관/발코니/주방)
// deps: 함께 필요한 연동 항목(기본 등급으로 제안)

export const WORK_ITEMS = [
  // 공통 (COM)
  { id: 'w_demo', group: '공통', name: '철거(마감재)', unit: 'm2', auto: { basis: 'A_floor' }, deps: ['w_waste'],
    grades: [ { g: '부분(도배·장판)', mat: 1000, lab: 12000 }, { g: '마감재 전체', mat: 2000, lab: 22000 }, { g: '올철거(주방·욕실 포함)', mat: 3000, lab: 33000 } ] },
  { id: 'w_waste', group: '공통', name: '폐기물 처리', unit: 'sik', auto: { basis: 'manual' },
    grades: [ { g: '톤백 반출', mat: 0, lab: 200000 }, { g: '1톤 차량', mat: 0, lab: 320000 }, { g: '2.5톤 차량', mat: 0, lab: 500000 } ] },
  { id: 'w_protect', group: '공통', name: '양생·보양', unit: 'sik', auto: { basis: 'manual' },
    grades: [ { g: '기본(세대 내)', mat: 100000, lab: 200000 }, { g: 'EV·복도 포함', mat: 180000, lab: 320000 } ] },
  { id: 'w_clean', group: '공통', name: '입주 청소', unit: 'm2', auto: { basis: 'A_floor' },
    grades: [ { g: '일반 입주청소', mat: 0, lab: 4000 }, { g: '준공청소(분진)', mat: 0, lab: 5500 } ] },
  // 창호 (WIN)
  { id: 'w_sash_bal', group: '창호', name: '발코니 샷시 교체', unit: 'm2', auto: { basis: 'A_win' },
    grades: [ { g: 'PVC 이중창 보급', mat: 250000, lab: 60000 }, { g: 'PVC 이중창 1군(LX·KCC)', mat: 400000, lab: 70000 }, { g: 'AL·시스템창', mat: 600000, lab: 90000 } ] },
  { id: 'w_sash_in', group: '창호', name: '내창(분합창) 교체', unit: 'm2', auto: { basis: 'A_win' },
    grades: [ { g: '단창', mat: 150000, lab: 50000 }, { g: '이중창', mat: 250000, lab: 60000 } ] },
  { id: 'w_glass', group: '창호', name: '유리만 교체', unit: 'm2', auto: { basis: 'A_win' },
    grades: [ { g: '일반 복층 22T', mat: 60000, lab: 35000 }, { g: '로이 복층', mat: 90000, lab: 40000 }, { g: '강화·접합', mat: 120000, lab: 45000 } ] },
  { id: 'w_sash_film', group: '창호', name: '샷시 필름 랩핑', unit: 'ea', auto: { basis: 'N_win' },
    grades: [ { g: '국산 단색', mat: 50000, lab: 90000 }, { g: '프리미엄(현대·LX)', mat: 80000, lab: 110000 } ] },
  // 현관 (ENT)
  { id: 'w_middoor', group: '현관', name: '중문', unit: 'ea', auto: { basis: 'manual' },
    grades: [ { g: '여닫이(스윙)', mat: 600000, lab: 250000 }, { g: '원슬라이딩', mat: 750000, lab: 280000 }, { g: '3연동 슬라이딩', mat: 1000000, lab: 350000 } ] },
  { id: 'w_shoecab', group: '현관', name: '신발장', unit: 'ja', auto: { basis: 'manual' },
    grades: [ { g: '필름 래핑만(식)', mat: 120000, lab: 180000 }, { g: '표준 키큰장(자당)', mat: 90000, lab: 35000 }, { g: '키큰장+벤치(자당)', mat: 130000, lab: 45000 } ] },
  { id: 'w_entfloor', group: '현관', name: '현관 바닥타일', unit: 'sik', auto: { basis: 'room', roomType: '현관' },
    grades: [ { g: '600각 덧방', mat: 120000, lab: 160000 }, { g: '파벽·모자이크', mat: 180000, lab: 200000 } ] },
  { id: 'w_entdoor', group: '현관', name: '현관문 필름·도장', unit: 'ea', auto: { basis: 'manual' },
    grades: [ { g: '내부면 필름', mat: 60000, lab: 100000 }, { g: '내외부 필름', mat: 90000, lab: 140000 } ] },
  // 문 (DOR)
  { id: 'w_door_leaf', group: '문', name: '방문 교체(문짝만)', unit: 'ea', auto: { basis: 'N_door' },
    grades: [ { g: 'ABS 보급', mat: 110000, lab: 60000 }, { g: '멤브레인', mat: 150000, lab: 60000 }, { g: '원목도어', mat: 220000, lab: 80000 } ] },
  { id: 'w_door_set', group: '문', name: '문짝+문틀 세트', unit: 'ea', auto: { basis: 'N_door' },
    grades: [ { g: 'ABS 세트', mat: 220000, lab: 120000 }, { g: '원목 세트', mat: 320000, lab: 130000 } ] },
  { id: 'w_door_paint', group: '문', name: '방문 도장/필름', unit: 'ea', auto: { basis: 'N_door' },
    grades: [ { g: '문틀 필름만', mat: 30000, lab: 70000 }, { g: '문+문틀 필름', mat: 60000, lab: 110000 }, { g: '우레탄 올도장', mat: 60000, lab: 160000 } ] },
  { id: 'w_handle', group: '문', name: '손잡이·경첩 교체', unit: 'ea', auto: { basis: 'N_door' },
    grades: [ { g: '일반 레버', mat: 20000, lab: 12000 }, { g: '무광블랙·골드', mat: 40000, lab: 15000 } ] },
  // 수납 (STO)
  { id: 'w_builtin', group: '수납', name: '붙박이장 신설', unit: 'ja', auto: { basis: 'manual' },
    grades: [ { g: '여닫이 기본(자당)', mat: 110000, lab: 45000 }, { g: '슬라이딩(자당)', mat: 150000, lab: 55000 }, { g: '드레스룸 시스템(자당)', mat: 190000, lab: 60000 } ] },
  { id: 'w_sto_film', group: '수납', name: '기존 장 필름 래핑', unit: 'sik', auto: { basis: 'manual' },
    grades: [ { g: '단색', mat: 180000, lab: 320000 }, { g: '우드·스톤 패턴', mat: 250000, lab: 380000 } ] },
  { id: 'w_shelf', group: '수납', name: '시스템 선반', unit: 'sik', auto: { basis: 'manual' },
    grades: [ { g: '지주식', mat: 180000, lab: 120000 }, { g: '목공 제작', mat: 250000, lab: 250000 } ] },
  // 주방 (KIT)
  { id: 'w_kitchen', group: '주방', name: '싱크대 상하부장', unit: 'm', auto: { basis: 'manual' }, deps: [],
    grades: [ { g: '도어만 교체(m당)', mat: 180000, lab: 80000 }, { g: '사제 PET(m당)', mat: 550000, lab: 180000 }, { g: '브랜드(한샘급, m당)', mat: 900000, lab: 220000 } ] },
  { id: 'w_counter', group: '주방', name: '상판 교체', unit: 'm', auto: { basis: 'manual' },
    grades: [ { g: '인조대리석', mat: 300000, lab: 100000 }, { g: '칸스톤', mat: 550000, lab: 150000 }, { g: '세라믹', mat: 800000, lab: 200000 } ] },
  { id: 'w_sinkbowl', group: '주방', name: '씽크볼+수전', unit: 'sik', auto: { basis: 'manual' },
    grades: [ { g: '사각 스텐+거위목', mat: 200000, lab: 100000 }, { g: '대형 백조급+풀아웃', mat: 350000, lab: 120000 } ] },
  { id: 'w_kitwall', group: '주방', name: '주방 벽타일', unit: 'sik', auto: { basis: 'manual' },
    grades: [ { g: '서브웨이 유광', mat: 180000, lab: 220000 }, { g: '600각 포세린', mat: 250000, lab: 280000 } ] },
  { id: 'w_hood', group: '주방', name: '후드 교체', unit: 'ea', auto: { basis: 'manual' },
    grades: [ { g: '슬라이드 빌트인', mat: 200000, lab: 60000 }, { g: '침니형', mat: 350000, lab: 80000 } ] },
  { id: 'w_cooktop', group: '주방', name: '쿡탑 교체', unit: 'ea', auto: { basis: 'manual' }, deps: ['w_dedic'],
    grades: [ { g: '3구 인덕션 국산', mat: 500000, lab: 80000 }, { g: '하이브리드', mat: 700000, lab: 80000 }, { g: '수입(밀레·보쉬)', mat: 1300000, lab: 100000 } ] },
  { id: 'w_island', group: '주방', name: '아일랜드·홈바', unit: 'sik', auto: { basis: 'manual' },
    grades: [ { g: '수납형', mat: 700000, lab: 300000 }, { g: '식탁 겸용 반도형', mat: 1200000, lab: 400000 } ] },
  // 욕실 (BAT)
  { id: 'w_bath_pkg', group: '욕실', name: '욕실 전체 리모델링', unit: 'sik', auto: { basis: 'room', roomType: '욕실' },
    grades: [ { g: '덧방 기본', mat: 2200000, lab: 2000000 }, { g: '철거+방수 재시공', mat: 2800000, lab: 3300000 }, { g: '프리미엄(욕조·조적)', mat: 4500000, lab: 4200000 } ] },
  { id: 'w_toilet', group: '욕실', name: '양변기 교체', unit: 'ea', auto: { basis: 'room', roomType: '욕실' },
    grades: [ { g: '국산 투피스', mat: 180000, lab: 100000 }, { g: '원피스', mat: 400000, lab: 110000 }, { g: '비데일체형', mat: 900000, lab: 150000 } ] },
  { id: 'w_basin', group: '욕실', name: '세면대 교체', unit: 'ea', auto: { basis: 'room', roomType: '욕실' },
    grades: [ { g: '반다리', mat: 120000, lab: 80000 }, { g: '긴다리', mat: 160000, lab: 80000 }, { g: '카운터형+하부장', mat: 550000, lab: 150000 } ] },
  { id: 'w_bathfaucet', group: '욕실', name: '욕실 수전(세면+샤워)', unit: 'sik', auto: { basis: 'room', roomType: '욕실' },
    grades: [ { g: '국산 일반 2개소', mat: 130000, lab: 70000 }, { g: '해바라기 샤워 포함', mat: 300000, lab: 100000 } ] },
  { id: 'w_shower', group: '욕실', name: '샤워부스·파티션', unit: 'sik', auto: { basis: 'manual' },
    grades: [ { g: '유리 파티션 1면', mat: 280000, lab: 150000 }, { g: '도어형 부스', mat: 550000, lab: 250000 } ] },
  { id: 'w_tub2shower', group: '욕실', name: '욕조 철거→샤워부스', unit: 'sik', auto: { basis: 'manual' }, deps: ['w_waterproof'],
    grades: [ { g: '철거+타일+파티션', mat: 500000, lab: 600000 } ] },
  { id: 'w_bathacc', group: '욕실', name: '욕실 악세서리', unit: 'sik', auto: { basis: 'room', roomType: '욕실' },
    grades: [ { g: '기본 5종', mat: 90000, lab: 60000 }, { g: '매립수납+무광 디자인', mat: 200000, lab: 100000 } ] },
  { id: 'w_waterproof', group: '욕실', name: '방수 공사', unit: 'sik', auto: { basis: 'manual' },
    grades: [ { g: '액체방수+도막', mat: 150000, lab: 250000 }, { g: '담수시험 포함', mat: 180000, lab: 320000 } ] },
  // 벽·아트월 (WAL)
  { id: 'w_artwall', group: '벽·아트월', name: '아트월(TV월)', unit: 'sik', auto: { basis: 'manual' },
    grades: [ { g: '타일 아트월', mat: 700000, lab: 500000 }, { g: '우드 루버', mat: 900000, lab: 600000 }, { g: '대형 세라믹+선반', mat: 1600000, lab: 900000 } ] },
  // 조명·전기 (ELE)
  { id: 'w_switch', group: '조명·전기', name: '스위치·콘센트 교체', unit: 'ea', auto: { basis: 'manual' },
    grades: [ { g: '국산 일반', mat: 8000, lab: 12000 }, { g: '무광블랙·토글·USB', mat: 20000, lab: 15000 } ] },
  { id: 'w_wiring', group: '조명·전기', name: '배선 증설', unit: 'ea', auto: { basis: 'manual' },
    grades: [ { g: '노출 몰드', mat: 20000, lab: 60000 }, { g: '매립(까대기)', mat: 40000, lab: 100000 } ] },
  { id: 'w_panel', group: '조명·전기', name: '분전반·차단기', unit: 'sik', auto: { basis: 'manual' },
    grades: [ { g: '차단기 개별', mat: 40000, lab: 60000 }, { g: '분전반 전체', mat: 250000, lab: 300000 } ] },
  { id: 'w_dedic', group: '조명·전기', name: '인덕션 전용선', unit: 'sik', auto: { basis: 'manual' },
    grades: [ { g: '4sq 전용회로', mat: 100000, lab: 180000 } ] },
  // 설비 (PLB)
  { id: 'w_boiler', group: '설비', name: '보일러 교체', unit: 'ea', auto: { basis: 'manual' },
    grades: [ { g: '일반형', mat: 800000, lab: 250000 }, { g: '콘덴싱', mat: 1200000, lab: 280000 } ] },
  { id: 'w_pipes', group: '설비', name: '수도배관 교체', unit: 'sik', auto: { basis: 'manual' },
    grades: [ { g: '부분(밸브·분배기)', mat: 100000, lab: 130000 }, { g: '세대 전체 PB관', mat: 1000000, lab: 1600000 } ] },
  { id: 'w_aircon', group: '설비', name: '에어컨 매립배관', unit: 'ea', auto: { basis: 'manual' },
    grades: [ { g: '배관 세척·수리', mat: 50000, lab: 200000 }, { g: '신설(실당)', mat: 400000, lab: 700000 } ] },
  // 발코니 (BAL)
  { id: 'w_expand', group: '발코니', name: '발코니 확장 마감', unit: 'm2', auto: { basis: 'A_floor', roomType: '발코니' }, deps: ['w_sash_bal'],
    grades: [ { g: '단열+바닥+난방', mat: 150000, lab: 170000 } ] },
  { id: 'w_elastic', group: '발코니', name: '탄성코트', unit: 'sik', auto: { basis: 'room', roomType: '발코니' },
    grades: [ { g: '수성 탄성코트', mat: 120000, lab: 230000 }, { g: '결로방지 단열도료', mat: 200000, lab: 300000 } ] },
  { id: 'w_insul', group: '발코니', name: '내단열 보강', unit: 'm2', auto: { basis: 'manual' },
    grades: [ { g: '이보드', mat: 25000, lab: 35000 }, { g: '아이소핑크+석고', mat: 40000, lab: 60000 } ] },
  { id: 'w_deck', group: '발코니', name: '바닥 데크·타일', unit: 'm2', auto: { basis: 'A_floor', roomType: '발코니' },
    grades: [ { g: '조립식 데크타일', mat: 35000, lab: 15000 }, { g: '포세린 타일', mat: 40000, lab: 70000 } ] },
];

export const WORK_GROUPS = (() => {
  const gs = [];
  for (const w of WORK_ITEMS) if (!gs.includes(w.group)) gs.push(w.group);
  return gs;
})();

// 등급 포함 평탄화: extras 는 'w_toilet#1' 형태의 flat id 로 저장 → item()/ratesOf() 그대로 동작
const _workFlat = new Map();
for (const w of WORK_ITEMS) {
  w.grades.forEach((gr, i) => {
    _workFlat.set(`${w.id}#${i}`, {
      id: `${w.id}#${i}`, base: w.id, group: w.group,
      name: w.name, spec: gr.g, unit: w.unit,
      mat: gr.mat, lab: gr.lab, auto: w.auto, deps: w.deps || [],
    });
  });
}
export function workGrade(baseId, gi) { return _workFlat.get(`${baseId}#${gi}`); }
export function workItem(baseId) { return WORK_ITEMS.find(w => w.id === baseId); }

export const ALL_RATED = [...FINISH_FLOOR, ...FINISH_WALL, ...FINISH_CEIL, ...CEIL_TYPES,
                          ...WALL_TYPES, ...LIGHTS, ...TRIMS];

const _byId = new Map(ALL_RATED.map(e => [e.id, e]));
export function item(id) { return _byId.get(id) || _workFlat.get(id); }

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
export const unitKo2 = u => u === 'm2' ? '㎡' : u === 'm' ? 'm' : u === 'sik' ? '식' : u === 'ja' ? '자' : '개';

/// 실 용도 분류 (자동 수량 규칙의 roomType 필터)
export function roomTypeOf(name) {
  const n = name || '';
  if (/욕실|화장실/.test(n)) return '욕실';
  if (/현관/.test(n)) return '현관';
  if (/발코니|베란다/.test(n)) return '발코니';
  if (/주방|부엌/.test(n)) return '주방';
  if (/거실/.test(n)) return '거실';
  return '방';
}

// 구버전 프로젝트 호환
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
