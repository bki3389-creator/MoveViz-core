# CAD 건축 평면도 파이프라인 (신규)

거친 경계 → **실제 건축 평면도**(200mm 이중선 벽 + 문 스윙 호 + 창 3선 + 치수 + 가구 카테고리).
production v4 검출은 무수정, 후처리·렌더만 추가.

## 흐름
```
scan.glb
  └ run_v4.py          # production v4: boundary·walls·openings(문/창/lintel)·rooms·furniture
       └ furniture_postprocess.refine_furniture   # 폴리캠식 후처리: 카테고리·표준치수 스냅·축정렬·중복병합
  └ render_cad_plan.py  # → SVG: 200mm 벽·문 스윙·창 글레이징·치수·가구라벨
```

## 사용
```bash
source 19_texture_nonlidar/.venv/bin/activate   # numpy·trimesh·shapely·scipy
cd 02_웹앱_GLB파이프라인/glb-floorplan_1/glb-floorplan
python run_v4.py scan.glb -o out.json
python render_cad_plan.py out.json -o plan.svg   # --wall 0.20 (200mm 고정)
```

## 신규 파일
- `run_v4.py` — production v4 파이프라인 CLI(= server_furniture_v5 non-CAD 경로) + 가구 후처리.
- `furniture_postprocess.py` — 가구 정제. 검출 무수정 순수 후처리.
  - ① Manhattan 축정렬(0/90 ±14° 스냅) ② 규칙 카테고리(침대/소파/식탁/책상/의자/옷장/냉장고/세탁기/수납장/TV장) + 표준치수 스냅(잔차<임계일 때만, over-snap 방지) ③ 회전각 `angle_deg` 노출 ④ IoU 중복병합.
- `render_cad_plan.py` — v4 JSON → 건축 평면도 SVG. shapely로 200mm 벽 밴드(이중선), 개구부 사각형으로 벽 절단, 문=스윙 호·창=3평행선, 외곽 치수선.

## 벽 두께
**200mm 고정**(`WALL_T=0.20`). 인테리어라 외벽 실측이 무의미 → 측정 안 함(설계 결정). 기둥은 추후.

## 한계(정직)
- 가구 카테고리·위치 정확도는 **검출(glb_furniture_v5, F1 0.357)** 한계에 종속. 후처리는 *좋은 검출을 정돈*할 뿐, 오검출(과검출·45° 오배치)은 못 고침 → 폴리캠 수준 가구는 RoomPlan(기기) 검출이 필요.
- 문/창은 v4의 sill 밴드 휴리스틱 기반 → 유리 반사·가림에 따라 오검출 가능.
- LiDAR/비-LiDAR 둘 다: 입력이 GLB 메시면 소스 무관하게 동일 동작(비-LiDAR=Object Capture USDZ→GLB).

## 산출물 예시
`floorplans/cad/cad_2026.3.13_final.svg` 등 (벡터 SVG).
