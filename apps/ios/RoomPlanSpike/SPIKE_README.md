# RoomPlan 도입 스파이크 (트랙 A)

> 결정 메모: `MOVEVIZ/18_pipeline_research/RoomPlan_도입_의사결정메모.md`
> 목적: **"이미 LiDAR 쓰는데 RoomPlan 안 쓸 이유가 있나?"** 를 1주 안에 숫자로 결론낸다.

RoomPlan(시맨틱 벽/문/창/가구) + 기존 메시(ARMeshAnchor)를 **한 스캔에서 동시 수집**하고,
3가지 Go/No-Go 기준을 실측한다.

## 구성
- `RoomPlanSpikeManager.swift` — RoomPlan 구동 + 메시 동시수집 측정 + JSON/USDZ/PLY export
- `RoomPlanSpikeView.swift` — `RoomCaptureView(frame:arSession:)` 프리뷰 + 실시간 측정 패널

## 요구사항
- **iOS 17+**, **LiDAR 기기**(iPhone Pro / iPad Pro). 시뮬레이터·비-LiDAR 기기 불가.
- `Info.plist`에 `NSCameraUsageDescription` (기존 AR 앱이라 이미 있을 것).
- 타깃에 `import RoomPlan` 사용 → RoomPlan.framework 자동 링크(iOS SDK 포함).

## Xcode 통합 (5분)
1. `RoomPlanSpike/` 폴더의 두 `.swift`를 앱 타깃에 추가(Target Membership 체크).
2. 앱에서 스파이크 화면을 띄운다. 가장 빠른 방법 — 앱 진입점을 임시로 교체:
   ```swift
   // MoveVizApp.swift (임시)
   @main
   struct MoveVizApp: App {
       var body: some Scene {
           WindowGroup { RoomPlanSpikeEntry() }   // ← 스파이크 화면
       }
   }
   ```
   또는 기존 화면에 버튼 추가:
   ```swift
   .sheet(isPresented: $showSpike) { RoomPlanSpikeEntry() }
   ```
3. 실기기(LiDAR) 빌드·실행.

## 측정 절차 (방 3개)
실제 방 **3개**를 각각 스캔: ① 단순 직교 방, ② 가구 밀집 방, ③ **거울/유리** 포함 방.
각 방: **Start** → 천천히 한 바퀴(문/창/가구 포함) → **Stop & 처리**.
처리 끝나면 하단 패널 + `Documents/roomplan_spike_report.json`에 측정값이 남는다.

## 3가지 Go/No-Go 기준
| # | 측정값(앱 표시) | GO | 보류/폴백 |
|---|---|---|---|
| **① 동시수집** | `bothFrames/sampledFrames` (메시+depth 동시 프레임 비율) | **≥ 90%** → 동시 듀얼트랙 GO | < 90% → `stop(pauseARSession:false)` **릴레이**로 폴백 설계 |
| **② 시맨틱** | 문/창/개구부/가구 수 + 카테고리 | 우리 휴리스틱 대비 개구부 **+30%p** 또는 오검출 **-50%** → 어댑터 GO | 개선 < 10%p → 어댑터 보류 |
| **③ 치수** | 바닥면적·벽길이 vs **줄자 실측** | 면적 오차 **≤ 5%** → 대략견적 채택 | > 10% → 치수는 메시 정본, RoomPlan은 시맨틱 전용 |

**판정:** ① GO 이고 (② 또는 ③ 중 하나 GO) → **트랙 A 본채택**.
① 폴백성공 + ② GO → **릴레이 방식 채택**. ① 실패 + ②③ 미달 → **보류**.

## 산출물 (앱 Documents / temp)
- `roomplan_capturedroom.json` — CapturedRoom(Codable) → 다운스트림 어댑터(`roomplan_adapter.py`) 입력
- `roomplan_room.usdz` — 시각화/검증
- `roomplan_spike_mesh_*.ply` — 듀얼트랙 메시 정점(기존 파이프라인 호환, temp)
- `roomplan_spike_report.json` — 3가지 측정값
> 기기에서 꺼내기: Xcode → Devices and Simulators → 앱 → Download Container, 또는 파일 앱 공유.

## 측정 핵심 설계 (왜 이렇게 쟀나)
- **델리게이트를 뺏지 않는다.** RoomPlan이 ARSession을 정상 구동하도록 두고, `arSession.currentFrame`을
  0.1s 간격으로 **비침습 샘플링**해 `sceneDepth != nil` & `ARMeshAnchor 존재`를 센다.
  → RoomPlan 동작을 깨지 않으면서 "동시 수집"을 정직하게 측정.
- WWDC23: *"custom ARWorldTrackingConfiguration will be honored inside RoomCaptureSession"* —
  단 포럼에 `sceneDepth`가 덮어써지는 보고가 있어, **이 스파이크가 그 진위를 직접 가린다**(기준 ①).

## GO가 나오면 다음 (구현 순서)
1. `roomplan_adapter.py` — CapturedRoom JSON → 우리 `xw/zw`+openings 스키마 (≈200–300줄), `to_ifc.py` 인터페이스 유지.
2. 가구 16종 → MVP `room-data` 카테고리/부피 매핑(이사 견적 직결).
3. 듀얼트랙 융합: RoomPlan=시맨틱 오버레이, 메시=외곽/임의가구/정밀치수 정본.

## NO-GO(보류)면
현 메시 단독 파이프라인 유지 + 결정 메모의 중기 항목(M1 평면 알고리즘 교체, M2 가구 세그멘테이션)으로 전환.
