# GLB → Floor Plan Pipeline

LiDAR로 스캔한 GLB 메쉬 파일을 입력받아 2D 평면도(닫힌 Manhattan polygon)를 자동 추출하는 파이프라인.

## 구조

```
glb-floorplan/
├── glb_to_floorplan.py          # GLB → JSON 변환 (Python CLI)
├── consensus_boundary_explorer.jsx  # JSON → 평면도 시각화 (React)
├── examples/
│   ├── 2026__3__13_consensus.json
│   ├── 2026__3__14_consensus.json
│   ├── 2026__3__15_consensus.json
│   └── 2026__3__16_consensus.json
└── README.md
```

## 사용법

### 1. GLB → JSON 변환

```bash
pip install trimesh numpy scipy
python glb_to_floorplan.py scan.glb -o output.json
```

옵션:
- `--step 0.2` : 슬라이스 간격 (m, 기본 0.2)
- `--snap 0.06` : 벽선 snap 허용 오차 (m, 기본 0.06)
- `--min-wall 0.4` : 최소 벽 길이 (m, 기본 0.4 — 이보다 짧은 벽은 무시)

### 2. 시각화

`consensus_boundary_explorer.jsx`는 React 컴포넌트. JSON 파일을 로드하면 평면도를 렌더링함.

로드 방법:
- Choose File 버튼으로 JSON 선택
- 드래그 앤 드롭
- 텍스트 붙여넣기 + Load Data 버튼

표시 옵션:
- Point cloud: 벽면 포인트클라우드
- Closed boundary: 닫힌 외곽 폴리곤
- Built-in: 붙박이장/카운터 등 부분 출현 벽선
- Dimensions: 각 변의 치수
- Mirror X / Invert Z: 좌표 방향 토글

## 알고리즘 개요

### Step 1 — Mesh Load
GLB를 trimesh로 로드. glTF Y-up 좌표계 유지.

### Step 2 — Floor/Ceiling Detection
수평면(face normal Y > 0.85)의 Y 히스토그램에서 지배적 수평면을 찾아 바닥/천장 결정.

### Step 3 — Horizontal Slicing
바닥에서 천장까지 200mm 간격으로 수평 슬라이스. 각 슬라이스에서 face normal 필터로 벽면 포인트 추출:
- `|Y| < 0.3` = 벽면
- `|X| > 0.7` = X방향 벽 (Z축에 평행)
- `|Z| > 0.7` = Z방향 벽 (X축에 평행)

### Step 4 — Consensus Wall Lines
**전체 슬라이스의 포인트를 합산한 히스토그램**에서 피크 추출 → consensus 벽선.
슬라이스별이 아닌 전체 합산이 핵심. 슬라이스별로 하면 메쉬 울퉁불퉁함 때문에 같은 벽이 다른 bin에 분산됨.

### Step 5 — Classification
각 벽선에 대해 ±0.06m snap 범위에서 슬라이스별 support 측정:
- **structure**: 50%+ 슬라이스 출현, span ≥ 0.4m
- **built-in**: 25%+ 출현
- **noise**: 나머지

### Step 6 — Boundary Polygon
Structure 벽선 중 가장 바깥쪽 + 가장 긴 span을 가진 벽으로 닫힌 Manhattan polygon 구성.
- 왼쪽 돌출(ㄱ자) 자동 감지
- 현관 파임(ㅁ자) 자동 감지
- 40cm 미만 벽 무시

## JSON 출력 스키마

```json
{
  "m": {
    "n": 11,                    // 슬라이스 수
    "h": [0.0, 0.2, ..., 2.0]  // 각 슬라이스 높이 (m)
  },
  "xw": [                       // X방향 벽선 (Z축에 평행)
    {
      "pos": -1.61,             // X 좌표
      "segs": [[-3.8, 3.8]],   // 벽선 따라 segment [z_start, z_end]
      "presence": 11,           // 출현 슬라이스 수
      "support": 2787,          // 전체 합산 히스토그램 투표 수
      "span": 5.26,             // 전체 segment 길이 합 (m)
      "cls": "structure"        // structure | built-in | noise
    }
  ],
  "zw": [...],                  // Z방향 벽선 (동일 구조)
  "boundary": [                 // 닫힌 Manhattan polygon [[x,z], ...]
    [-1.83, -1.27],             // 코너 A
    [-1.61, -1.27],             // 코너 B
    ...
    [-1.83, -1.27]              // 닫힘 (A와 동일)
  ],
  "fp": [[x, z], ...],         // 전체 벽면 포인트클라우드 (다운샘플 ~2000점)
  "sp": {                       // 슬라이스별 포인트클라우드
    "slice_00_0.00m": [[x, z], ...],
    ...
  },
  "bounds": {                   // 포인트 범위
    "x": [-2.2, 5.8],
    "z": [-4.3, 3.9]
  },
  "xh": [...],                  // X벽 전체 합산 히스토그램 (시각화용)
  "zh": [...],                  // Z벽 전체 합산 히스토그램
  "xhb": {"s": -2.3, "d": 0.02, "n": 411},  // X 히스토그램 bin 설정
  "zhb": {"s": -4.36, "d": 0.02, "n": 419}   // Z 히스토그램 bin 설정
}
```

## 좌표계

- glTF Y-up: X = 수평, Y = 높이(위), Z = 수평
- 평면도: XZ 평면 (Y는 높이 → 슬라이스)
- 시각화: **Invert Z 해제, Mirror X 해제**가 기본 (3D 뷰어 탑다운과 일치)

## 핵심 원칙

1. **Vertical consensus**: 개별 슬라이스가 아닌 전체 높이 합산으로 벽선 추출
2. **Manhattan assumption**: 모든 구조벽은 직교 (곡선은 opening evidence)
3. **닫힌 폴리곤**: 최종 바운더리는 반드시 닫힌 직각 다각형
4. **40cm 필터**: 40cm 미만 벽은 노이즈로 무시

## 의존성

- Python 3.8+
- trimesh
- numpy
- scipy
- React 18+ (시각화 컴포넌트)
