# MoveViz iOS

iPhone으로 공간을 스캔해서 3D 모델과 평면도를 만들고, 이사 견적까지 이어지는 iOS 앱.

## 주요 기능

- **공간 스캔** — ARKit 기반 포인트클라우드 스캔 (LiDAR 기기는 자동 활성화, 일반 기기는 Feature Points로 동작), RoomPlan 스캔 모드 지원 (`RoomPlanSpike/`)
- **커버리지 미니맵** — 스캔 중 탑뷰로 스캔 범위 실시간 확인 (`MiniMapView`)
- **내보내기** — PLY / COLMAP 포맷 내보내기 (`PLYExporter`), GLB 메쉬 변환 (`MeshExporter`)
- **3D 뷰어 & 평면도** — 스캔 결과 3D 확인 (`ModelViewer`), 평면도 뷰 (`App/FloorPlanView`, `FloorPlan3DView`)
- **이사 견적** — 스캔 데이터 기반 견적 산출 (`QuoteEngine`, `MoveQuoteViews`)
- **서버 업로드** — 스캔 결과를 처리 서버로 업로드 (`ScanUploader`)

## 프로젝트 구조

```
MoveVizApp.swift        앱 진입점 (@main)
ScanManager.swift       AR 세션 + 포인트 축적 + 커버리지 로직
ARScanView.swift        ARView의 SwiftUI 래퍼
ScanningView.swift      메인 스캔 화면 UI
App/                    탭 루트, 뷰어, 견적, 저장/업로드 등 화면
Modes/                  스캔 모드 선택 (카메라 전용 모드 포함)
RoomPlanSpike/          RoomPlan API 실험 (키프레임 녹화, 포토그래메트리)
floorplan/              PLY → 평면도 추출 Python 파이프라인
project.yml             XcodeGen 프로젝트 정의
```

## 빌드

- 요구사항: Xcode, iOS 16.0+ **실기기** (ARKit은 시뮬레이터 불가)
- `project.yml` 기반 [XcodeGen](https://github.com/yonaskolb/XcodeGen) 프로젝트:

```bash
xcodegen generate   # MoveViz.xcodeproj 재생성 (선택)
open MoveViz.xcodeproj
```

Xcode에서 실기기 선택 후 Run.

## 평면도 추출 (PC)

```bash
cd floorplan
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python extract_floorplan.py <scan.ply>
```

자세한 설치/데모 흐름은 [SETUP.md](SETUP.md) 참고.
