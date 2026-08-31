# PlanShot — iOS 현장 흐름 (2026-08-30, 브랜치 `feat/planshot-flow`)

제안서 `PlanShot_제안서_260813_full_v2.pdf`의 약속을 MoveViz iOS 앱 위에 구현한 것. 맥 서버 없이 폰에서 끝난다.

```
현장(세대) ─ 방 스캔(RoomPlan, 2~3분) ─ 도면(이중선·문/창·mm·평수·CH·타이틀블록)
   │               │                        │
   │               └ 레이저 보정(축별)        ├ 배치안(탑뷰 레이아웃 편집기)
   │                                        ├ 공내역(BOQ) → 단가표 → xlsx
   └ 세대 합산(㎡·평·천장고·문/창)            └ PDF(요약+방별+공내역) / DXF(R12) → 카톡 공유
```

## 파일 (apps/ios/App)

| 파일 | 역할 |
|---|---|
| `ProjectStore.swift` | `PlanProject`(현장) / `PlanRoomRef`(방=스캔 참조 + `PlanCorrection` + `layout`) / `ProjectStore`(Documents/projects.json) / `PlanUnits`(평 환산·mm) |
| `PlanMetrics.swift` | `RoomMetrics`(면적·둘레·천장고·문/창·벽 순면적·걸레받이) / `PlanData.applying(correction)` |
| `PlanModel.swift` | `PlanData` Codable화, `PlanRoom.name`, `PlanOpening.height`, `fromRoomPlan(… ceiling:, floorPolygon:, doorHeights:, windowHeights:)` |
| `FloorPlanView.swift` | `PlanSheetInfo`(타이틀블록·워터마크) + 방 이름/실별 치수/평/CH/면책 푸터 렌더 |
| `PlanShot/PSTheme.swift` | 디자인 토큰·버튼·카드·배지·빈 상태·단계 바 |
| `PlanShot/ProjectsView.swift` | 현장 목록(검색·히어로) + `ProjectFormSheet` |
| `PlanShot/ProjectDetailView.swift` | 세대 합산 카드·방 목록·스캔 추가·PDF/공내역/xlsx/DXF 내보내기·ShareLink |
| `PlanShot/RoomScanView.swift` | RoomPlan 스캔 → 미리보기 → 방 이름 → 현장에 추가(plan.json 귀속) |
| `PlanShot/RoomDetailView.swift` | 도면(2D/3D)·지표·배치안·레이저 보정(`CorrectionSheet`)·`RoomPlanLoader` |
| `PlanShot/LayoutEditorView.swift` | 탑뷰 레이아웃 편집기(`LayoutItem`, `FurnitureCatalog`, 드래그/회전/치수/경고) |
| `PlanShot/BOQEngine.swift` | 공내역 엔진(`BOQDocument`, `RateTable`, `RateTableStore`, 산출 규칙) |
| `PlanShot/BOQView.swift` | 공내역 화면·단가 입력·할증/공종 설정·CSV 단가표 |
| `PlanShot/BOQXLSXExporter.swift` | 순수 Swift STORED-ZIP + OOXML(수식 포함) xlsx |
| `PlanShot/PlanPDFExporter.swift` | ImageRenderer → CGContext PDF (요약·방별·공내역 페이지) |
| `PlanShot/DXFExporter.swift` | DXF R12(AC1009), CP949, 레이어 A-WALL/A-DOOR/A-GLAZ/A-FURN/A-ANNO-* |

RootTabView: **현장 / 내 스캔 / 설정**. 기존 LiDAR→맥·카메라·RoomPlan 스파이크는 설정 > 실험 기능.

## 데이터 위치 (기기)
- `Documents/projects.json` — 현장·방·보정·배치안
- `Documents/savedScans/<id>/` — `scan.usdz`, `roomplan.json`(CapturedRoom), `plan.json`(PlanData, 스캔 시 귀속)
- `Documents/rate_table.json` — 업체 단가표·할증 설정
- `UserDefaults` — `planshot.company`, `planshot.noWatermark`

## 산출 규칙 요약
- 면적: iOS 17 `floors[].polygonCorners`(월드 변환) 우선, 없으면 벽 bbox. 평 = ㎡ × 0.3025.
- 천장고: 벽 `dimensions.y` 중앙값(1.5~5m 필터). 보정 시 수동값 우선.
- 벽 순면적 = 둘레 × 천장고 − Σ(문 폭 × 문 높이) − Σ(창 폭 × 창 높이) (높이 미상 시 2.1/1.2m).
- 걸레받이 = 둘레 − 문 폭, 몰딩 = 둘레. 욕실·발코니는 도배/강마루 제외. 방문 = 방 수.
- 레이저 보정 v1: 가로/세로 레이저값 → 축별 배율을 방 전체에 적용. 천장고 수동 입력.

## 검증 상태
- Windows에서 Swift 타입체크 불가(Foundation 헤더 없음) → **Mac Xcode 빌드 필수**. pbxproj에 신규 파일 등록됨(XcodeGen 불필요, `xcodegen generate` 해도 동일).
- xlsx 템플릿: 파이썬 쌍둥이로 생성 → Excel COM에서 열어 수식(SUM·부가세·총계) 계산 확인 ✅.
- DXF 템플릿: 파이썬 쌍둥이(`planshot_twin.dxf`) → AutoCAD 열기 테스트(아래 결과 참조).
- RoomPlan 실기기 3기준(동시수집·시맨틱·치수)은 미측정 — Phase 0.

## 웹 미니BIM (apps/web-minibim, 2026-08-31)

폰 실측 plan.json → 웹 3D 스튜디오: 2D 도면 확인 → 3D 클릭으로 벽/바닥/천장 유형·재료 지정,
조명 설치(다운/펜던트/라인/마그네틱, 실광원), 실시간 견적(단가 인라인 수정)·CSV·인쇄.
정적 ES 모듈(three 내장) — `py -3 -m http.server` 로 실행. 로직은 node 테스트로 검산
(벽/개구부 매칭·거실 순면적 41.21㎡ 수기검산 일치). 원조는 MoveMate-client(아키톤) —
벽 편집 도구·GLB 가구 이식 예정. 상세: apps/web-minibim/README.md

## 미구현 / 다음
- 결제(StoreKit2)·계정 — 워터마크 토글만.
- 멀티룸 좌표 정합(세대 통합 도면) — v1은 방별 페이지.
- AI 시각화(p7): 2D 시안은 구조 제어(뎁스/캐니 from RoomPlan) + 이미지 모델(클라우드), 3D는 생성이 아니라 **재료 매핑 + 가구 카탈로그 치환**으로.
- 벽 하나 단위 스팟 보정, 곡선/사선 벽.
