<!-- 생성: roomplan-decision 워크플로우(리서치3+iOS코드분석2+검증2+결정1). 근거=Apple 1차문서+코드 직접검증+적대적 팩트체크 -->
<!-- 경로 정정: 활성 glb_to_floorplan.py는 02_웹앱_GLB파이프라인/glb-floorplan_1/glb-floorplan/ (10_확인필요/files5는 사본) -->

# 의사결정 메모: "LiDAR를 이미 강제하는데, RoomPlan을 안 쓸 이유가 남아있는가?"

작성: Principal Engineer / Product Strategy · 2026-06-23

---

## 결론 먼저

**권고: 조건부 GO — "1주 스파이크(트랙 A)"는 즉시 진행하되, 제품 채택은 스파이크 결과에 묶는다.**

LiDAR 강제 전제 하에서 RoomPlan을 "안 쓸 이유"로 거론되는 후보(LiDAR 전용, 16개 가구 한정, 치수 부정확, 거울/유리, 블랙박스 락인)를 전수 검토한 결과, **그 자체로 도입을 막는 진짜 결격(deal-breaker)은 없다.** RoomPlan이 주는 것 — 벽/문/창/개구부의 **시맨틱 라벨**과 16종 가구의 **6DoF 포즈+박스 치수+신뢰도** — 은 지금 우리 파이프라인이 메시 기하에서 **법선·슬라이싱으로 힘들게 역추정하는 것**(`glb_to_floorplan.py`)을 무료로 준다. 다만 **두 가지 사실이 "전면 교체"를 막는다**: ① RoomPlan은 파라메트릭 단순화라 비-Manhattan 외곽·임의 가구·정밀 치수를 우리가 여전히 직접 풀어야 하고, ② 우리 다운스트림(`to_ifc.py`)은 RoomPlan JSON과 **스키마가 근본적으로 다르다**(세그먼트 벽 vs 폐곡선). 따라서 정답은 "교체"가 아니라 **듀얼트랙(RoomPlan 시맨틱 + 기존 메시 기하)** 이며, 그 전제(한 스캔에서 둘 다 안정적으로 수집)가 성립하는지를 스파이크로 먼저 검증해야 한다.

추가로 정정해 둘 사실: **우리 iOS 코드는 LiDAR를 "강제(hard-gate)"하지 않는다.** `ScanManager.startScan()`(라인 76-123)은 LiDAR 유무와 무관하게 실행되고, LiDAR가 있으면 `meshWithClassification`+`sceneDepth`를 켜고(라인 84-89) 없으면 feature points만 모은다(라인 256). 즉 현재는 **"LiDAR 조건부 고품질 활성화 + 비-LiDAR 저밀도 폴백"** 구조다. 이 차이가 섹션 2의 전략적 긴장의 핵심이다.

---

## 1. "안 쓸 이유" 후보 전수 검토

| 후보 (RoomPlan 반대 이유) | 실제로 유효한가 | 우리에게 무의미/유효한 근거 |
|---|---|---|
| **LiDAR + iOS16/17 전용** | **우리에겐 무의미** | RoomPlan의 최대 진입장벽은 LiDAR 요구인데, 우리는 이미 LiDAR가 있을 때 고품질 경로를 쓴다. 디바이스 게이팅 고민이 사라짐. 멀티룸·커스텀 ARSession은 iOS 17+, 16종 가구 enum은 **iOS 16 도입**(팩트체크 정정: iOS 17 아님). |
| **가구 16종으로 한정** (bathtub…washerDryer) | **부분 유효, 비결격** | enum은 정확히 16개·연관값 없음(1차 확인). 전등·러그·식물은 출력 안 됨. 그러나 이사견적의 핵심은 **부피·동선·면적**이라 16종 박스로 충분하고, 카테고리 밖 물체는 **우리 메시가 이미 잡고 있다**(듀얼트랙). |
| **치수 부정확** | **개념은 유효, 단정 금지** | Apple이 공표한 95%/90%/91%는 전부 **검출(detection) precision/recall**이지 치수 오차 보증이 아님(Apple ML Research). "37cm 편차/±5cm/벽"은 **단일 블로그(it-jim) 단일 사례** → 사양처럼 인용 불가. 결론만 신뢰: **견적 금액 치수를 RoomPlan에 직접 묶지 말 것.** |
| **거울/유리/암면 오인식** | **유효, 단 비결격** | Apple **공식(WWDC22 10127)** 이 "full-height mirror·glass·very dark surface가 LiDAR에 어렵다"고 자기 인정. 단 이건 RoomPlan만의 문제가 아니라 **우리 LiDAR 메시도 동일하게 겪는 문제** → RoomPlan을 안 쓸 이유가 아님(우리도 못 푸는 건 마찬가지). 사용자 코칭으로 흡수. |
| **곡선/빗각 벽 단순화** | **유효, 한국 주거선 비결격** | 파라메트릭 모델의 구조적 귀결(Apple 공식 규정). iOS17에서 slanted/circular 개선(WWDC23 공식)됐으나 잔존 한계는 3자 관측. 한국 아파트/빌라는 대부분 직교 벽이라 실질 영향 작음. |
| **멀티룸 좌표 합성 난이도** | **유효, 핵심 실무 리스크** | `StructureBuilder.capturedStructure(from:)`(iOS 17)가 병합하나 연속 ARSession+relocalization에 의존, **다층 통합 불가**. "집 전체 단일 모델" 의존은 위험 → **방별 면적 합산 + relocalization 폴백**으로 설계. |
| **블랙박스/Apple 락인** | **약한 리스크, 헤지 가능** | 알고리즘은 통제 못 하나 출력은 **`Codable` JSON + USDZ 표준**이라 데이터 락인은 약함. **LiDAR 원시 메시를 함께 보관**하는 헤지로 충분. |
| **비-LiDAR(영상→COLMAP) 경로 포기 비용** | **거의 없음** | INDEX.md(L134)가 COLMAP/PLY 1차 경로를 "포인트클라우드 raster 노이즈 한계 → 메시+벡터로 발전"으로 명시. **코드는 살아있으나 활성 유지보수 대상 아님.** RoomPlan 채택이 포기시키는 활성 자산이 사실상 없음. |

**소결:** LiDAR 강제 전제가 가장 큰 단점(하드웨어 요구)을 흡수하고, 나머지는 전부 "우리 메시도 어차피 겪는 문제"이거나 "설계로 흡수 가능"이다. **단독 결격 없음.**

---

## 2. 진짜 남는 단 하나의 전략적 긴장 — LiDAR 전용 정밀 vs B2C 무마찰 성장

이것이 이 의사결정에서 **유일하게 진짜 어려운 충돌**이다.

- **RoomPlan은 본질적으로 LiDAR 전용 정밀 경로다.** 의미 있는 출력(시맨틱+치수)은 iPhone Pro/iPad Pro에서만 나온다.
- **우리가 앞서 만든 growth MVP는 설치 없는 웹(사진 업로드)** 이었다 — 무마찰 B2C 성장 가설. 이 경로의 사용자는 **LiDAR가 없거나 앱조차 안 깐다.**
- 또한 현재 iOS 코드는 LiDAR를 **강제하지 않는다**(섹션 0). 즉 코드는 비-Pro 기기도 받아들이도록 짜여 있고, RoomPlan을 넣으면 그 폴백 사용자에겐 **RoomPlan 가치가 0**이다.

**이 긴장을 어떻게 볼 것인가 — 분리하라.** RoomPlan은 **성장 깔때기의 정답이 아니라, 전환·정밀의 정답**이다.

- **무마찰 웹(사진→COLMAP/추정)** = 깔때기 상단, 도달·리드. 정밀도 낮아도 "대략 견적"으로 충분.
- **RoomPlan(LiDAR 앱)** = 깔때기 하단, "확정 견적/현장 실측/B2B(이사업체 기사용 Pro 기기)". 정밀·시맨틱이 돈이 되는 지점.

따라서 **둘은 경쟁이 아니라 단계가 다른 제품**이다. RoomPlan 도입은 웹 성장 가설을 부정하지 않는다 — **"고가치 전환 단계의 품질 업그레이드"** 로 포지셔닝하면 충돌이 해소된다. 단, 의사결정으로 못 박을 것: **RoomPlan을 회원가입/온보딩 게이트로 두지 말 것.** 무마찰 웹 진입을 유지하고, RoomPlan은 "정밀 모드/현장 모드"로 옵트인.

---

## 3. 듀얼트랙 설계 — RoomPlan 시맨틱 + 기존 메시 기하

### 3a. 한 스캔에서 둘 다 뽑는 게 기술적으로 가능한가

**판정: API 레벨에서는 가능(확인). 단 "동시 안정 수집"은 Apple 보증 아님 — 스파이크로 검증 필요.**

- `RoomCaptureSession`은 `init(arSession: ARSession? = nil)`로 **커스텀 ARSession 주입을 공식 지원**(iOS 17, WWDC23 honor 명시, 1차 확인). 우리의 `ARWorldTrackingConfiguration`(이미 `meshWithClassification`+`sceneDepth` 설정 — ScanManager 라인 85-87)을 주입할 수 있다.
- `RoomCaptureSession.arSession` 프로퍼티 + `ARSessionDelegate`로 `ARMeshAnchor`/`sceneDepth`를 베스트에포트 수집 가능. 우리 `didAdd anchors`의 `ARMeshAnchor` 처리(ScanManager 라인 279)를 **그대로 재사용**할 수 있다.
- **검증된 마찰(중요):** 커스텀 ARSession 주입 후 들어오는 frame에서 `frameSemantics.contains(.sceneDepth) == false`로 나오는 보고가 있다(유효 근거: **Apple Forums thread/710134** — 팩트체크 정정: thread/723818은 컴파일 에러 스레드라 근거 부적합). RoomPlan 내부 reconfigure가 frameSemantics를 덮어쓰는 정황. Apple DTS는 "구성 변경은 즉시 반영 안 되니 델리게이트 콜백(`didAdd room:`)에서 재확인하라"고 안내.
- **방어 설계:** (1) 매 콜백에서 frameSemantics 재검증·재적용. (2) 동시 수집이 불안정하면 `stop(pauseARSession: false)`로 **같은 ARSession을 이어받아** 우리 config로 `run`하는 **2단계 릴레이**(좌표계 연속 → 후처리 정합 비용 낮음)를 폴백으로.

### 3b. RoomPlan JSON이 `glb_to_floorplan` 다운스트림을 대체/보강하는가

**판정: 전면 대체 불가(스키마 근본 차이), 보강은 고가치.**

- 우리 파이프라인은 **메시 기하 → 벡터 세그먼트** 축약: `glb_to_floorplan.py`가 trimesh로 GLB를 로드(라인 18-22 확인)하고 face_normals로 바닥/천장(Y법선)·X/Z벽을 검출, `to_ifc.py`는 `xw/zw` 세그먼트 배열 + `pos/segs/cls` + `openings` 스키마를 기대한다.
- RoomPlan은 **폐곡선(boundary) 기반** — `Surface.Category`(.wall/.door(isOpen:)/.window/.opening/.floor) + `transform`+`dimensions`+`confidence`. 세그먼트↔폐곡선, 좌표축, 개구부 표현, 분류(structure/built-in/noise)가 전부 불호환.
- **따라서 어댑터가 필요**(`roomplan_adapter.py`, 추정 200-300줄): RoomPlan JSON → xw/zw 역변환 + 개구부 매핑 + 높이 명시. `to_ifc.py` 인터페이스는 유지 → IFC 출력 영향 없음.
- **그러나 진짜 가치는 "대체"가 아니라 "보강"이다.** RoomPlan이 **문/창/개구부를 직접 라벨링**해 주므로, 지금 우리가 메시 gap에서 휴리스틱으로 추정하는 개구부 검출을 **시맨틱 ground truth로 교정**할 수 있다. 가구 16종 박스는 BOM/부피 계산에 바로 투입. **권장: RoomPlan을 시맨틱 오버레이로 쓰고, 외곽 형상·임의 가구·정밀 치수는 기존 메시를 정본(authoritative)으로 유지.**
- **저장 전략:** RoomPlan 원천은 `CapturedRoom`을 `JSONEncoder().encode(...)`로 round-trip 저장(transform/dimensions/category/confidence 보존), USDZ는 시각화용. 우리 PLY/GLB 메시는 그대로 보관 → 락인 헤지.

---

## 4. RoomPlan이 여전히 '우리가 직접 풀어야 하는' 것

RoomPlan을 넣어도 **위임되지 않는** 책임 (도입해도 우리 백로그에 남음):

1. **정밀 치수 검증.** confidence는 검출 신뢰도지 치수 정밀도가 아님(Apple). 견적 금액 치수는 **LiDAR 메시/수동 보정으로 검증** — RoomPlan 박스 치수에 직접 묶지 말 것. `confidence == .low` 필터링은 합리적 정책.
2. **비-Manhattan 외곽·임의 형상.** 파라메트릭 단순화로 직각화되는 곡선/빗각 외곽은 **우리 메시 기하가 정본.**
3. **카테고리 밖 물체(전등·러그·식물·박스 등).** 16종 밖은 RoomPlan이 출력 안 함 → 메시/커스텀 ML 레이어가 담당.
4. **거울/유리/암면.** Apple도 인정한 한계 — RoomPlan도 우리 메시도 동일하게 못 푼다. 사용자 코칭(`Instruction.turnOnLight` 등)으로 흡수하되, **자동 해결 가정 금지.**
5. **멀티룸/다층 합성.** `StructureBuilder`는 단일 평면 가정·다층 불가. "방별 면적 합산 안전, 집 전체 단일 모델 의존 위험" — relocalization 실패 폴백 필수.

---

## 5. Go/No-Go — 트랙 A(RoomPlan 스파이크)에서 측정할 구체 기준 3가지

**스파이크 범위:** 1주, LiDAR 기기(iPhone Pro) 1대, 실제 방 3개(직교 1, 가구 밀집 1, 거울/유리 포함 1). 커스텀 ARSession 주입 방식으로 RoomPlan + 메시 동시 수집 시도.

| # | 측정 기준 (숫자) | GO | 보류/폴백 |
|---|---|---|---|
| **1. 동시 수집 안정성** | RoomPlan 세션 중 `frameSemantics.contains(.sceneDepth)`가 유지되고 `ARMeshAnchor`가 들어오는 프레임 비율 | **≥ 90%** 프레임에서 메시+sceneDepth 동시 수집 유지 → **동시 듀얼트랙 GO** | 90% 미만/불안정 → 동시 포기, **`stop(pauseARSession:false)` 2단계 릴레이로 폴백 설계** (이것도 안 되면 보류) |
| **2. 시맨틱 보강 가치 (개구부)** | RoomPlan이 라벨한 문/창/개구부 vs 우리 메시 휴리스틱 검출의 일치/교정 효과. 실측 대비 개구부 검출 | RoomPlan 적용 시 개구부 검출 정확도가 현재 대비 **≥ 30%p 개선** 또는 오검출 **≥ 50% 감소** → 보강 가치 입증, **어댑터 GO** | 개선 < 10%p → 시맨틱 보강 가치 낮음, 어댑터 투자 **보류** |
| **3. 치수 신뢰 경계** | 벽 길이/면적: RoomPlan 박스 치수 vs LiDAR 메시 치수의 편차(줄자 실측 기준) | RoomPlan 면적 오차가 **실측 대비 ≤ 5%**이면 "대략 견적" 용도로 채택 가능 | 오차 > 10% 또는 케이스별 분산 큼 → **RoomPlan은 시맨틱 라벨 전용, 모든 치수는 메시 정본** (이미 본 메모의 기본 가정 — 이 경우에도 시맨틱 가치만으로 GO 가능) |

**판정 규칙:**
- **#1 GO이고 (#2 또는 #3 중 하나라도 GO)** → **트랙 A 본채택**: 듀얼트랙(또는 릴레이) + `roomplan_adapter.py` + 시맨틱 오버레이.
- **#1 폴백 성공이고 #2 GO** → **릴레이 방식으로 채택**(좌표계 연속 보장).
- **#1 실패 + #2/#3 모두 미달** → **보류**: 현재 메시 단독 파이프라인 유지, RoomPlan은 다음 분기 재평가.

---

### 사실/추측 경계 (메모 신뢰도)
- **사실(Apple 1차):** LiDAR 강제 시 진입장벽 해소, 16종 가구 enum(iOS 16), 5종 Surface, `init(arSession:)`/`stop(pauseARSession:)`(iOS 17), `StructureBuilder`(iOS 17, 다층 불가), 검출지표≠치수정밀도, 거울/유리/암면 한계(WWDC22 공식), `Codable` JSON 직렬화.
- **개발자 관측(단일/소수 출처, 단정 금지):** 37cm·±5cm/벽 편차, 50cm 벽 분할, 곡선 갭·자동 직각화 구체 증상, sceneDepth 소실(유효 근거 thread/710134) — **모두 "관측 사례"로만 사용, 사양으로 인용 금지.**
- **코드 정정:** "LiDAR 강제"는 사용자 전제이나 실제 `ScanManager`는 hard-gate가 아니라 조건부 활성화 + 비-LiDAR 폴백(feature points)을 유지 중 — 섹션 2의 전략 판단 근거.

관련 파일: `apps/ios/ScanManager.swift`(스캔 설정, feature points, mesh) · `services/floorplan/glb_to_floorplan_v4.py`(trimesh 의존) · `tools/bim-export/to_ifc.py`(xw/zw·openings 스키마)
