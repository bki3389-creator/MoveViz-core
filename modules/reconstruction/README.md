# 19_texture_nonlidar — 메시 텍스처링 + 비-LiDAR 재구성

폴리캠의 두 기능을 우리 스택에 구현. 근거: [구현계획_텍스처_비LiDAR.md](구현계획_텍스처_비LiDAR.md)
(딥리서치 + 코드분석 + 적대적 검증).

## 기능 1 — 메시 위 이미지 매핑 (텍스처링)

방식: **projective vertex coloring** ("Let There Be Color!" / OpenMVS 계열을 정점 단위로 단순화).
우리 PLY/GLB 파이프라인이 정점색을 이미 지원하므로 가장 적은 변경으로 색이 붙는다.

- **`colorize_vertices.py`** — 코어. 메시 + 포즈 있는 RGB 프레임들 → 정점색.
  정점을 각 카메라에 투영 → 가시성(back-face/raycast) → 정면도 가중 평균.
  - 검증: `python colorize_vertices.py --selftest`
    → ① 투영 수식 ② 픽셀 round-trip ③ **멀티뷰 큐브 복원(커버리지 100%, 색오차 0.0)** 전부 PASS.
    실제 51k 정점 스캔 GLB에서도 동작 확인.
  - 실사용: `python colorize_vertices.py --mesh scan.glb --views <폴더> --out colored.ply`
- **iOS `KeyframeRecorder.swift`** (`03_iOS앱/MoveViz-iOS/RoomPlanSpike/`) — 색 소스 캡처.
  현재 우리 스캔은 카메라 transform만 모으고 RGB·intrinsics는 안 모은다 → 이걸 추가.
  ARFrame에서 키프레임(JPEG + intrinsics K + transform + 해상도)을 throttle 저장 →
  `poses.json` 산출(= `colorize_vertices.py`의 `--views` 입력 포맷, ARKit→OpenCV 포즈 자동 변환).
  - 검증: **BUILD SUCCEEDED** (실제 iOS SDK). 런타임 색 정합은 실기기 필요.

### 텍스처 end-to-end
```
[iOS] 스캔 + KeyframeRecorder → poses.json + kf_*.jpg
   ↓ (Documents에서 꺼내기)
[desktop] python colorize_vertices.py --mesh scan.glb --views keyframes/ --out colored.ply
   → 정점색 메시(PLY/GLB). 우리 뷰어/파이프라인이 색을 그대로 사용.
```

## 기능 2 — 비-LiDAR 폰 재구성 (포토그래메트리)

방식: **Apple Object Capture (`PhotogrammetrySession`)** — LiDAR 불필요(사진 MVS).
출력 USDZ → GLB → 기존 평면도 파이프라인(`glb_to_floorplan.py`)에 그대로 투입.

- **iOS `PhotogrammetryManager.swift`** — 사진 폴더 → USDZ.
  `PhotogrammetrySession.isSupported` 런타임 게이트(기기 수치 하드코딩 안 함).
  KeyframeRecorder가 모은 사진을 그대로 입력으로 쓴다.
  - 검증: **BUILD SUCCEEDED**. 런타임 재구성은 지원 기기 필요.
- **`usdz_to_glb.py`** — USDZ → GLB (pxr로 Mesh 추출 → 월드변환 → 삼각화 → trimesh export, 정점색 보존).
  - 검증: `python usdz_to_glb.py --selftest` → 실제 .usdz 패키지 생성→변환(8정점/12삼각형/색보존) **PASS**.
  - 실사용: `python usdz_to_glb.py model.usdz -o model.glb`

### 비-LiDAR end-to-end
```
[iOS, 비-LiDAR] KeyframeRecorder 사진 → PhotogrammetryManager(PhotogrammetrySession) → USDZ
   ↓
[desktop] python usdz_to_glb.py model.usdz -o model.glb
   ↓
[기존] glb_to_floorplan.py model.glb → 평면도/면적
```

> ⚠️ **스케일 주의(검증 반박 사항):** 순수 SfM은 절대 스케일 모호. 단안 뎁스(Depth Anything/Depth Pro)로
> cm급 메트릭 복원은 **불가**(도메인 밖 오차 수십cm~1m). 스케일은 KeyframeRecorder가 함께 저장하는
> **ARKit 포즈(실측 baseline/gravity)** 또는 **마커(ArUco/스케일바)** 로 앵커링해야 한다.
> 줄자 실측이 ground truth — 단안 메트릭을 검증 지표로 쓰지 말 것.

## 환경
```
python3 -m venv .venv && source .venv/bin/activate
pip install numpy trimesh Pillow opencv-python-headless scipy pygltflib usd-core
```

## 다음 단계
- iOS: 스캔 화면에서 KeyframeRecorder 연결(매 프레임 record), 비-LiDAR 진입에 PhotogrammetryManager.
- desktop: `colorize_vertices`의 raycast 오클루전을 대형 메시에서 가속(BVH/pyembree)·텍스처 아틀라스(선택).
- 스케일 앵커링 모듈(ARKit 포즈/마커) → 면적 오차 측정.
