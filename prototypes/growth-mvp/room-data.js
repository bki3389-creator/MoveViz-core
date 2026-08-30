// room-data.js
// 개인정보가 포함될 수 있는 실제 스캔 대신 만든 합성 방 경계와 대표 가구 세트.
// 크기와 배치는 제품 흐름 시연용이며 실측값이나 고객 데이터를 나타내지 않는다.

export const ROOM = {
  id: "demo-synthetic",
  label: "원룸+1.5 · 합성 예시",
  // [x, z] (meter). 시연을 위해 만든 합성 외곽선.
  boundary: [
    [-2.2, -4.0], [2.2, -4.0], [2.2, 2.0], [1.6, 2.0],
    [1.6, 4.0], [-2.2, 4.0], [-2.2, -4.0],
  ],
  bounds: { x: [-2.2, 2.2], z: [-4.0, 4.0] },
  ceilingHeight: 2.4,
};

// 대표 가구. w(가로)·d(세로)·h(높이) m, weight kg, [x,z] 중심, rot(rad).
// 부피/무게는 이사 견적 산출의 입력값이 된다(트럭 대수·인건비).
export const FURNITURE = [
  { name: "퀸 침대",   icon: "🛏️", w: 1.55, d: 2.05, h: 0.55, weight: 62, x: 1.0,  z: -3.0, rot: 0,        color: "#9db4ff" },
  { name: "옷장",      icon: "🚪", w: 1.20, d: 0.60, h: 2.00, weight: 82, x: -1.2, z: -3.5, rot: 0,        color: "#c8a98a" },
  { name: "냉장고",    icon: "🧊", w: 0.70, d: 0.72, h: 1.82, weight: 76, x: 1.7,  z: 1.4,  rot: 0,        color: "#cfd8e3" },
  { name: "3인 소파",  icon: "🛋️", w: 2.05, d: 0.92, h: 0.80, weight: 46, x: -0.8, z: 1.3,  rot: 0,        color: "#a7d7b5" },
  { name: "책상",      icon: "🖥️", w: 1.40, d: 0.70, h: 0.75, weight: 28, x: 1.4,  z: -1.2, rot: Math.PI/2, color: "#d8c98a" },
  { name: "책장",      icon: "📚", w: 0.80, d: 0.32, h: 1.80, weight: 38, x: -1.4, z: -1.8, rot: Math.PI/2, color: "#caa17f" },
  { name: "세탁기",    icon: "🌀", w: 0.62, d: 0.62, h: 0.86, weight: 64, x: -1.7, z: 3.3,  rot: 0,        color: "#d3dbe6" },
  { name: "식탁",      icon: "🍽️", w: 1.20, d: 0.78, h: 0.74, weight: 30, x: -0.6, z: -0.4, rot: 0,        color: "#d8b48a" },
  { name: "TV·거치장", icon: "📺", w: 1.30, d: 0.40, h: 0.55, weight: 24, x: 1.7,  z: -0.2, rot: Math.PI/2, color: "#8d97a6" },
];

// ── 갤러리("남의 집 구경") — 소셜 증거 + 부러움 루프 (오늘의집의 길) ──
// 회의에서 나온 "남의 집 훔쳐보는" 욕구 = 저빈도 서비스를 평소에 붙잡는 콘텐츠 훅.
// 사각형/L자 등 다양한 방 + 가구 부분집합으로 "사람들이 이미 쓰고 있다"는 인상을 준다.
function rect(w, d) { return [[0,0],[w,0],[w,d],[0,d],[0,0]]; }
export const GALLERY = [
  { label: "역삼동 · 원룸 7평",   region: "🔥 인기", likes: 312,
    boundary: rect(3.2, 4.4),
    furniture: [FURNITURE[0], FURNITURE[1], FURNITURE[4], FURNITURE[8]] },
  { label: "연남동 · 투룸 15평",   region: "신혼", likes: 528,
    boundary: [[0,0],[5.2,0],[5.2,3.0],[3.0,3.0],[3.0,4.8],[0,4.8],[0,0]],
    furniture: [FURNITURE[0], FURNITURE[3], FURNITURE[2], FURNITURE[7], FURNITURE[5]] },
  { label: "성수동 · 오피스텔 9평", region: "1인가구", likes: 197,
    boundary: rect(3.6, 3.6),
    furniture: [FURNITURE[0], FURNITURE[2], FURNITURE[3], FURNITURE[8]] },
  { label: "망원동 · 복층 11평",   region: "자취", likes: 441,
    boundary: [[0,0],[4.0,0],[4.0,2.4],[2.4,2.4],[2.4,4.0],[0,4.0],[0,0]],
    furniture: [FURNITURE[0], FURNITURE[1], FURNITURE[5], FURNITURE[6], FURNITURE[4]] },
];

// ── "우리집" — 방 하나가 아니라 집 전체를 합산해야 진짜 이사 견적이 된다 ──
// 스캔한 "내 방"에 거실·주방 등을 추가할수록 전체 견적이 완성된다.
// (저빈도 서비스의 약점인 리텐션 + 집 전체 공간 데이터 수집을 동시에 푸는 장치)
export const ADD_ROOMS = [
  { name: "거실", icon: "🛋️", furniture: [
    { name: "4인 소파",   w: 2.40, d: 0.95, h: 0.80, weight: 55 },
    { name: "거실장·TV",  w: 1.80, d: 0.45, h: 0.50, weight: 35 },
    { name: "테이블",     w: 1.10, d: 0.60, h: 0.45, weight: 22 },
  ]},
  { name: "주방", icon: "🍳", furniture: [
    { name: "양문냉장고", w: 0.90, d: 0.75, h: 1.85, weight: 110 },
    { name: "김치냉장고", w: 0.70, d: 0.70, h: 1.25, weight: 70 },
    { name: "식탁세트",   w: 1.40, d: 0.85, h: 0.75, weight: 40 },
  ]},
  { name: "침실", icon: "🛏️", furniture: [
    { name: "킹 침대",    w: 1.80, d: 2.05, h: 0.60, weight: 80 },
    { name: "장롱",       w: 1.60, d: 0.60, h: 2.10, weight: 100 },
    { name: "화장대",     w: 1.00, d: 0.45, h: 1.40, weight: 35 },
  ]},
  { name: "세탁실·베란다", icon: "🧺", furniture: [
    { name: "드럼세탁기", w: 0.65, d: 0.70, h: 0.85, weight: 75 },
    { name: "건조기",     w: 0.65, d: 0.70, h: 0.85, weight: 55 },
    { name: "수납선반",   w: 0.90, d: 0.40, h: 1.80, weight: 25 },
  ]},
];

// 썸네일용: 가구를 방 경계 bbox 안 그리드에 자동 배치(겹침 최소화).
export function autoPlace(boundary, furniture) {
  const xs = boundary.map((p) => p[0]), zs = boundary.map((p) => p[1]);
  const minx = Math.min(...xs), maxx = Math.max(...xs);
  const minz = Math.min(...zs), maxz = Math.max(...zs);
  const m = 0.45; // 벽 여백
  const cols = Math.ceil(Math.sqrt(furniture.length));
  const rows = Math.ceil(furniture.length / cols);
  const cw = (maxx - minx - m * 2) / cols, ch = (maxz - minz - m * 2) / rows;
  return furniture.map((f, i) => {
    const c = i % cols, r = Math.floor(i / cols);
    return { ...f,
      x: minx + m + cw * (c + 0.5),
      z: minz + m + ch * (r + 0.5),
      rot: f.d > f.w ? Math.PI / 2 : 0 };
  });
}

// ── 이사 견적 산출 로직 ──────────────────────────────────────────
// 가구 부피 합 → 실적재 부피(여유율 반영) → 트럭 대수 → 견적.
// 한국 포장이사 시세를 단순·투명하게 모델링(데모용 근사치).
const TRUCKS = [
  { name: "1톤",   cap: 6.0,  base: 32 }, // cap=적재가능 부피 ㎥, base=만원(포장이사 근사)
  { name: "2.5톤", cap: 14.0, base: 58 },
  { name: "5톤",   cap: 25.0, base: 92 },
];

export function estimate(furniture = FURNITURE) {
  const rawVolume = furniture.reduce((s, f) => s + f.w * f.d * f.h, 0);
  const totalWeight = furniture.reduce((s, f) => s + f.weight, 0);
  // 박스/짐 + 적재 비효율 반영(가구 부피의 약 1.7배가 실제 트럭 점유)
  const loadVolume = rawVolume * 1.7;

  // 트럭 선택: 1대로 실리는 가장 작은 트럭 우선,
  // 가장 큰 트럭에도 안 들어가면 가장 큰 트럭을 여러 대.
  let pick = TRUCKS[TRUCKS.length - 1], count = 1;
  const single = TRUCKS.find((t) => loadVolume <= t.cap);
  if (single) {
    pick = single; count = 1;
  } else {
    pick = TRUCKS[TRUCKS.length - 1];
    count = Math.ceil(loadVolume / pick.cap);
  }

  // 견적: 트럭 base*대수 + 인건비(무게 비례) + 거리 가정(기본 포함)
  const truckCost = pick.base * count;
  const laborCost = Math.round((totalWeight / 100) * 6); // 100kg당 6만원 가정
  const low = Math.round((truckCost + laborCost) * 0.9);
  const high = Math.round((truckCost + laborCost) * 1.25);

  return {
    itemCount: furniture.length,
    rawVolume: +rawVolume.toFixed(1),
    loadVolume: +loadVolume.toFixed(1),
    totalWeight,
    truck: `${pick.name} ${count}대`,
    truckName: pick.name,
    truckCount: count,
    priceLow: low,
    priceHigh: high,
  };
}
