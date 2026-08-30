# MoveViz iOS App - Setup Guide

## 1. Xcode 프로젝트 생성 (Mac에서)

1. Xcode 열기 → **File → New → Project**
2. **iOS → App** 선택
3. 설정:
   - Product Name: `MoveViz`
   - Interface: **SwiftUI**
   - Language: **Swift**
   - Minimum Deployments: **iOS 16.0**
4. 프로젝트 생성 후 기존 `ContentView.swift` 삭제

## 2. 소스 파일 추가

이 폴더의 Swift 파일들을 Xcode 프로젝트에 드래그:

```
MoveVizApp.swift      ← App 진입점 (@main)
ScanManager.swift     ← AR 세션 + 포인트 축적 + 커버리지 로직
ARScanView.swift      ← ARView의 SwiftUI 래퍼
ScanningView.swift    ← 메인 스캔 화면 UI
MiniMapView.swift     ← 탑뷰 커버리지 미니맵
PLYExporter.swift     ← PLY/COLMAP 내보내기
```

## 3. Info.plist 설정

`Info.plist` 파일의 내용을 프로젝트의 Info.plist에 병합하거나,
Xcode Target → Info 탭에서 다음 키 추가:

- `NSCameraUsageDescription` → "MoveViz needs camera access..."
- `UIRequiredDeviceCapabilities` → `arkit`

## 4. 프레임워크

자동으로 링크되지만, 확인:
- **ARKit** (Target → General → Frameworks)
- **RealityKit**

## 5. 빌드 & 실행

- **실제 iPhone** 필요 (시뮬레이터에서 ARKit 불가)
- iPhone 12 Pro 이상이면 LiDAR 자동 활성화
- 일반 iPhone도 Feature Points로 동작

## 6. 서버 연동 (선택)

PC에서:
```bash
pip install flask flask-cors
python server/server.py
```

서버가 표시하는 IP를 앱의 Upload 화면에 입력.

## 전체 데모 플로우

```
1. 앱 실행 → Start 터치
2. 방 안을 천천히 돌아다니며 스캔
3. 미니맵에서 커버리지 실시간 확인
4. Stop → Export → Share PLY (AirDrop) 또는 Upload to Server
5. PC에서 extract_floorplan.py 실행 (또는 서버 자동 처리)
6. 평면도 결과 확인!
```
