# MoveViz — Sparse Point Cloud → Floor Plan Extractor

COLMAP sparse reconstruction 결과에서 2D 평면도를 자동 추출하는 Python 스크립트입니다.

## 파이프라인

```
COLMAP sparse point cloud (.ply / points3D.bin)
  → 포인트 로드
  → Outlier 제거
  → 바닥면 검출 (RANSAC)
  → 좌표계 정렬 (바닥 = XY 평면)
  → 벽 높이 구간 필터링
  → XY 투영 → 2D occupancy grid
  → Morphology → contour 추출
  → Polygon 단순화
  → rooms.json + top-view PNG
```

## 필요 라이브러리

```bash
pip install open3d numpy opencv-python shapely
```

## 사용법

### 기본 사용 (PLY 파일)

```bash
python extract_floorplan.py --input sparse_cloud.ply --output ./output
```

### COLMAP sparse 폴더 직접 사용

```bash
python extract_floorplan.py --input ./project/sparse/0 --output ./output
```

### 파라미터 조정

```bash
python extract_floorplan.py \
  --input sparse_cloud.ply \
  --output ./output \
  --resolution 0.05 \        # Grid 해상도 (미터, 작을수록 정밀)
  --z-min 0.3 \              # 벽 시작 높이 (바닥 위 30cm부터)
  --z-max 2.2 \              # 벽 끝 높이 (220cm까지)
  --kernel 5 \               # Morphology 커널 크기
  --morph-iter 3 \           # Dilation 반복 횟수
  --epsilon 0.02             # Polygon 단순화 비율
```

## COLMAP에서 PLY 내보내기

1. COLMAP에서 sparse reconstruction 완료
2. `File` → `Export model` → sparse 폴더에 저장
3. 또는 `Extras` → `Export as PLY`로 직접 PLY 저장

## 출력 파일

| 파일 | 설명 |
|------|------|
| `01_occupancy_raw.png` | XY 투영 원본 |
| `02_morphology.png` | Morphology 처리 결과 |
| `03_floorplan.png` | **최종 평면도** (축척 바 포함) |
| `rooms.json` | **가구 배치 알고리즘용 JSON** |
| `stats.json` | 처리 통계 |

## rooms.json 구조

```json
{
  "meta": {
    "version": "1.0",
    "unitSystem": "metric"
  },
  "rooms": [
    {
      "id": "room_01",
      "label": "스캔된 공간",
      "bounds": { "w": 4.2, "h": 3.8 },
      "polygon": [[0,0], [4.2,0], [4.2,3.8], [0,3.8]],
      "openings": []
    }
  ]
}
```

## 결과가 이상할 때 조정 방법

| 문제 | 해결 |
|------|------|
| 외곽선이 너무 작음 | `--z-min` 낮추기 (0.1) |
| 외곽선이 너무 큼 | `--z-max` 낮추기 (1.8) |
| 구멍이 많음 | `--kernel` 키우기 (7~9) |
| 너무 단순화됨 | `--epsilon` 줄이기 (0.01) |
| 노이즈가 많음 | `--resolution` 키우기 (0.08~0.1) |

## 테스트

```bash
python test_pipeline.py
```

가상 방(4m × 3.5m) 포인트클라우드를 생성하고 파이프라인을 테스트합니다.
