# MoveViz — 평면도 추출 실험 (Python)

ARKit 스캔으로 내보낸 **PLY 점구름 → 평면도(floor plan)** 를 PC에서 빠르게 실험하는 도구.
알고리즘이 확정되면 같은 로직을 Swift(앱)로 포팅해 **온디바이스 내장**하는 게 최종 목표.
(→ 최종 앱에는 이 서버/스크립트가 들어가지 않음. 지금은 "실험 단계"용.)

## 빠른 시작

```bash
cd floorplan
source .venv/bin/activate          # 가상환경 (numpy + matplotlib 설치됨)

# 1) 합성 방으로 동작 확인
python make_test_room.py test_room.ply
python extract_floorplan.py test_room.ply
open test_room_plan.png

# 2) 실제 스캔으로
python extract_floorplan.py /path/to/moveviz_scan.ply
```

아이폰에서 **Export → Share PLY → AirDrop** 으로 Mac에 받은 PLY를 그대로 넣으면 됩니다.

## 옵션

```
python extract_floorplan.py scan.ply \
    --res 0.03            # 격자 해상도(m). 작을수록 정밀/느림
    --band 0.3 0.4        # 벽 슬라이스: 바닥 위 / 천장 아래 여유(m)
    --peak-frac 0.20      # 벽 피크 임계(낮추면 벽 더 많이 검출)
    --no-align            # 맨해튼 회전 정렬 끄기
    --out plan.png
```

출력: `*_plan.png`(시각화) + `*_plan.json`(치수·벽선 좌표 — Swift 포팅 참고용).

## 알고리즘 단계 (Swift 포팅 시 이 순서로)

1. **PLY 로드** — ARKit은 Y가 위(up).
2. **바닥/천장 추정** — Y 히스토그램 피크.
3. **벽 슬라이스** — 바닥~천장 사이 수평 밴드만 추려 X-Z로 투영.
4. **맨해튼 정렬** — 벽 점이 두 축에 가장 잘 모이는 회전각 탐색 후 정렬.
5. **벽선 검출** — 정렬된 점의 행/열 투영 피크 = 벽 위치.
6. **치수 계산 + 렌더**.

> 💡 앱에 포팅할 땐 PLY 대신 **ARKit이 주는 수직 평면(ARPlaneAnchor)과 분류 메시(.wall)** 를
> 직접 쓰면 3~5단계가 훨씬 정확해집니다 (점구름엔 그 정보가 없음).

## 검증 결과 (합성 4×3m 방, 20° 회전, 문틈+가구+노이즈)

| 항목 | 정답 | 추출 |
|------|------|------|
| 천장고 | 2.5 m | 2.49 m |
| 회전각 | 20° | −20° |
| 방 크기 | 4.0 × 3.0 m | 4.08 × 3.07 m |
| 벽 | 4면 | 4면 |
