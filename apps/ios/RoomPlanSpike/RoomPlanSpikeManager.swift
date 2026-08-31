//  RoomPlanSpikeManager.swift
//  MoveViz — RoomPlan 도입 스파이크 (트랙 A)
//
//  목적: "이미 LiDAR를 쓰는데 RoomPlan을 안 쓸 이유가 있나?" 결정을 위해
//  RoomPlan(시맨틱 벽/문/창/가구) + 우리 기존 메시(ARMeshAnchor)를 "한 번의 스캔"에서
//  동시에 수집할 수 있는지, 그리고 시맨틱/치수 가치가 있는지를 숫자로 측정한다.
//
//  의사결정 메모(18_pipeline_research/RoomPlan_도입_의사결정메모.md)의 3가지 Go/No-Go 기준:
//   #1 동시 수집 안정성 — RoomPlan 세션 중 sceneDepth + ARMeshAnchor가 같은 프레임에 들어오는 비율 (목표 ≥90%)
//   #2 시맨틱 보강 가치 — RoomPlan이 라벨한 문/창/개구부 수 (우리 휴리스틱과 오프라인 비교)
//   #3 치수 신뢰 경계 — 벽 길이/바닥 면적을 줄자 실측과 비교 (목표 오차 ≤5%)
//
//  설계 핵심: RoomCaptureSession의 ARSession 델리게이트를 "뺏지 않는다".
//  대신 arSession.currentFrame을 0.1s 간격으로 비침습 샘플링 → RoomPlan 정상동작 보장하면서 #1 측정.
//
//  요구: iOS 17+, LiDAR 기기(iPhone/iPad Pro). 빌드/실측은 실기기 필요.

import Foundation
import RoomPlan
import ARKit
import Combine
import simd
import CoreGraphics

/// 온디바이스 평면도/결과 표시용 가구 항목.
struct RoomFurniture: Identifiable {
    let id = UUID()
    let name: String                   // 한글(표시)
    let cat: String                    // 영문(서버 평면도 심볼용)
    let cx: Float, cz: Float, yaw: Float  // 중심(XZ m) + yaw(도)
    let w: Float, d: Float, h: Float   // 가로(X)·세로(Z)·높이(Y) m
}

@available(iOS 17.0, *)
@MainActor
final class RoomPlanSpikeManager: NSObject, ObservableObject {

    // MARK: Published — UI/측정값
    @Published var isScanning = false
    @Published var status = "준비됨 — Start로 RoomPlan + 메시 동시 스캔"

    // #1 동시 수집 안정성
    @Published var sampledFrames = 0
    @Published var depthFrames = 0
    @Published var meshFrames = 0
    @Published var bothFrames = 0
    var coexistRatio: Double { sampledFrames == 0 ? 0 : Double(bothFrames) / Double(sampledFrames) }

    // #2 시맨틱(라이브 + 최종)
    @Published var wallCount = 0
    @Published var doorCount = 0
    @Published var windowCount = 0
    @Published var openingCount = 0
    @Published var objectCount = 0
    @Published var objectsByCategory: [String: Int] = [:]

    // #3 치수
    @Published var floorAreaM2: Double = 0
    @Published var wallLengths: [Double] = []   // 각 벽 길이(m)
    @Published var ceilingM: Double = 0         // 천장고(m) = 벽 높이 중앙값 (PlanShot 도면·물량용)
    @Published var lastSavedScanID: String?     // '내 스캔' 등록 id — 현장(프로젝트)에 방으로 귀속

    // 온디바이스 결과(평면도/표시용) — RoomPlan 모드 UI가 사용
    @Published var done = false
    @Published var walls2D: [[CGPoint]] = []     // 각 벽 [시작,끝] (XZ m)
    @Published var doors2D: [[CGPoint]] = []
    @Published var windows2D: [[CGPoint]] = []
    @Published var floor2D: [CGPoint] = []       // iOS 17 floors[0].polygonCorners → 월드 XZ (비정형 방)
    @Published var doorHeights: [Double] = []    // doors[i].dimensions.y (m)
    @Published var windowHeights: [Double] = []
    @Published var planMin = CGPoint(x: 0, y: 0)
    @Published var planSize = CGPoint(x: 1, y: 1)
    @Published var furnitureList: [RoomFurniture] = []
    var usdzURL: URL? {
        (exportedUSDZ.isEmpty || exportedUSDZ.contains("실패")) ? nil : URL(fileURLWithPath: exportedUSDZ)
    }

    // 산출물 경로
    @Published var exportedJSON = ""
    @Published var exportedUSDZ = ""
    @Published var exportedPLY = ""
    @Published var reportText = ""

    // MARK: 내부 상태
    // arSession은 우리가 소유(메시 config 주입). RoomCaptureView(frame:arSession:)가 이걸 공유한다.
    let arSession = ARSession()
    // RoomCaptureSession은 View(RoomCaptureView)가 만들어 주입 → bind()로 받는다.
    private weak var roomSession: RoomCaptureSession?
    private var sampleTimer: Timer?
    private var meshVertices: [SIMD3<Float>] = []   // 듀얼트랙 산출물(메시 정점 스냅샷)

    /// RoomCaptureView가 생성한 captureSession을 매니저에 연결(View.makeUIView에서 호출).
    func bind(_ session: RoomCaptureSession) {
        session.delegate = self
        roomSession = session
    }

    // MARK: - Control

    func start() {
        guard ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh) else {
            status = "⚠️ 이 기기는 LiDAR(sceneReconstruction)를 지원하지 않습니다. RoomPlan 스파이크는 LiDAR 기기 필요."
            return
        }
        guard let roomSession else {
            status = "⚠️ RoomCaptureView가 아직 연결되지 않았습니다(bind 전)."
            return
        }
        resetMetrics()

        // 1) 커스텀 ARSession: 우리 기존 파이프라인과 동일하게 메시 + depth + 평면을 켠다.
        //    WWDC23: "custom ARWorldTrackingConfiguration will be honored inside RoomCaptureSession"
        let cfg = ARWorldTrackingConfiguration()
        cfg.sceneReconstruction = .meshWithClassification
        if ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) {
            cfg.frameSemantics.insert(.sceneDepth)
        }
        cfg.planeDetection = [.horizontal, .vertical]
        arSession.run(cfg, options: [.resetTracking, .removeExistingAnchors])

        // 2) RoomPlan capture 시작(공유된 arSession 위에서)
        roomSession.run(configuration: RoomCaptureSession.Configuration())

        // 3) #1 비침습 샘플링 (델리게이트 안 뺏음 → RoomPlan 동작 보장)
        sampleTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.sampleFrame() }
        }

        isScanning = true
        status = "스캔 중 — 천천히 방을 한 바퀴 둘러보세요 (문/창/가구 포함)"
    }

    func stop() {
        sampleTimer?.invalidate(); sampleTimer = nil
        captureMeshSnapshot()                 // 듀얼트랙: 메시 정점 스냅샷 저장
        // pauseARSession:false → 같은 ARSession을 유지(다음 스캔 좌표 연속 / 폴백 릴레이용)
        roomSession?.stop(pauseARSession: false)
        isScanning = false
        status = "RoomPlan 후처리 중…"
    }

    /// 결과 화면에서 "다시 스캔" — 상태 초기화(다음 capture view가 새 세션 bind).
    func rescan() { resetMetrics() }

    private func resetMetrics() {
        sampledFrames = 0; depthFrames = 0; meshFrames = 0; bothFrames = 0
        wallCount = 0; doorCount = 0; windowCount = 0; openingCount = 0; objectCount = 0
        objectsByCategory = [:]; floorAreaM2 = 0; wallLengths = []
        ceilingM = 0; lastSavedScanID = nil
        meshVertices.removeAll()
        exportedJSON = ""; exportedUSDZ = ""; exportedPLY = ""; reportText = ""
        done = false; walls2D = []; doors2D = []; windows2D = []; furnitureList = []
        floor2D = []; doorHeights = []; windowHeights = []
    }

    // MARK: - #1 동시 수집 측정 (비침습)

    private func sampleFrame() {
        guard let frame = arSession.currentFrame else { return }
        sampledFrames += 1
        let hasDepth = frame.sceneDepth != nil
        let hasMesh = frame.anchors.contains { $0 is ARMeshAnchor }
        if hasDepth { depthFrames += 1 }
        if hasMesh { meshFrames += 1 }
        if hasDepth && hasMesh { bothFrames += 1 }
    }

    /// 종료 시점의 ARMeshAnchor 정점을 가볍게 스냅샷(듀얼트랙 산출물).
    private func captureMeshSnapshot() {
        guard let frame = arSession.currentFrame else { return }
        for anchor in frame.anchors {
            guard let mesh = anchor as? ARMeshAnchor else { continue }
            let g = mesh.geometry
            let vs = g.vertices
            let step = max(1, vs.count / 300)   // 앵커당 ~300점만
            for i in stride(from: 0, to: vs.count, by: step) {
                let p = vs.buffer.contents().advanced(by: vs.offset + vs.stride * i)
                let x = p.load(as: Float.self)
                let y = p.advanced(by: 4).load(as: Float.self)
                let z = p.advanced(by: 8).load(as: Float.self)
                let world = mesh.transform * SIMD4<Float>(x, y, z, 1)
                meshVertices.append(SIMD3<Float>(world.x, world.y, world.z))
            }
        }
    }

    // MARK: - 최종 처리 (RoomBuilder)

    private func process(_ data: CapturedRoomData) async {
        do {
            let builder = RoomBuilder(options: [.beautifyObjects])
            let room = try await builder.capturedRoom(from: data)
            finalize(room)
        } catch {
            status = "RoomPlan 처리 실패: \(error.localizedDescription)"
        }
    }

    private func finalize(_ room: CapturedRoom) {
        // #2 시맨틱 카운트
        wallCount = room.walls.count
        doorCount = room.doors.count
        windowCount = room.windows.count
        openingCount = room.openings.count
        objectCount = room.objects.count
        objectsByCategory = Dictionary(grouping: room.objects, by: { Self.categoryName($0.category) })
            .mapValues { $0.count }

        // #3 치수 — 벽 길이(Surface.dimensions.x = 벽 폭), 바닥 면적
        wallLengths = room.walls.map { Double($0.dimensions.x) }
        floorAreaM2 = Self.estimateFloorArea(room)
        ceilingM = Self.estimateCeiling(room)

        // 산출물 export
        exportAll(room)

        // 온디바이스 2D 평면도 + 가구 목록 계산
        computePlan(room)

        reportText = buildReport()
        done = true
        status = "✅ 완료 — 평면도/가구/3D 확인하세요."
    }

    /// CapturedRoom의 벽/문/창 Surface와 가구 Object를 2D(XZ)·목록으로 변환.
    private func computePlan(_ room: CapturedRoom) {
        func segs(_ surfaces: [CapturedRoom.Surface]) -> [[CGPoint]] {
            surfaces.map { s in
                let t = s.transform
                let c = t.columns.3                       // 중심(x,y,z)
                let half = CGFloat(s.dimensions.x) / 2     // 길이의 절반
                let ax = t.columns.0                       // 로컬 X = 길이 방향
                let nrm = (ax.x * ax.x + ax.z * ax.z).squareRoot()
                let ux = nrm > 1e-6 ? CGFloat(ax.x / nrm) : 0
                let uz = nrm > 1e-6 ? CGFloat(ax.z / nrm) : 0
                return [CGPoint(x: CGFloat(c.x) - ux * half, y: CGFloat(c.z) - uz * half),
                        CGPoint(x: CGFloat(c.x) + ux * half, y: CGFloat(c.z) + uz * half)]
            }
        }
        walls2D = segs(room.walls)
        doors2D = segs(room.doors)
        windows2D = segs(room.windows)
        doorHeights = room.doors.map { Double($0.dimensions.y) }
        windowHeights = room.windows.map { Double($0.dimensions.y) }
        floor2D = Self.floorPolygon(room)
        if floor2D.count >= 3 {
            let a = PlanMetrics.polygonArea(floor2D.map { [Double($0.x), Double($0.y)] })
            if a > 0.5 { floorAreaM2 = a }      // 바닥 폴리곤이 있으면 bbox 대신 실제 면적
        }
        let all = (walls2D + doors2D + windows2D).flatMap { $0 }
        if let minx = all.map({ $0.x }).min(), let maxx = all.map({ $0.x }).max(),
           let minz = all.map({ $0.y }).min(), let maxz = all.map({ $0.y }).max() {
            planMin = CGPoint(x: minx, y: minz)
            planSize = CGPoint(x: max(0.1, maxx - minx), y: max(0.1, maxz - minz))
        }
        furnitureList = room.objects.map { o in
            let t = o.transform
            let yaw = atan2(t.columns.0.z, t.columns.0.x) * 180 / .pi   // 로컬 X축 방위
            return RoomFurniture(name: Self.categoryName(o.category), cat: Self.categoryEN(o.category),
                                 cx: t.columns.3.x, cz: t.columns.3.z, yaw: yaw,
                                 w: o.dimensions.x, d: o.dimensions.z, h: o.dimensions.y)
        }
    }

    /// CapturedRoom.Object.Category → 서버 평면도 심볼용 영문 카테고리.
    static func categoryEN(_ c: CapturedRoom.Object.Category) -> String {
        switch c {
        case .storage: return "cabinet"
        case .refrigerator: return "refrigerator"
        case .stove, .oven, .dishwasher: return "appliance"
        case .bed: return "bed"
        case .sink: return "sink"
        case .washerDryer: return "appliance"
        case .toilet: return "toilet"
        case .bathtub: return "bathtub"
        case .table: return "table"
        case .sofa: return "sofa"
        case .chair: return "chair"
        case .fireplace: return "fireplace"
        case .stairs: return "stairs"
        case .television: return "tv"
        @unknown default: return "cabinet"
        }
    }

    // 바닥 면적(근사): 벽 중심들의 XZ 바운딩 박스. #3은 줄자 실측과 대조하므로 근사로 충분.
    // (CapturedRoom.floors 배열 API는 SDK 버전 의존성이 있어 사용하지 않음)
    private static func estimateFloorArea(_ room: CapturedRoom) -> Double {
        let centers = room.walls.map { $0.transform.columns.3 }   // SIMD4<Float> (x,y,z,w)
        guard !centers.isEmpty else { return 0 }
        let xs = centers.map { $0.x }, zs = centers.map { $0.z }
        let w = Double((xs.max() ?? 0) - (xs.min() ?? 0))
        let d = Double((zs.max() ?? 0) - (zs.min() ?? 0))
        return w * d
    }

    /// iOS 17: floors[].polygonCorners(로컬 좌표) → Surface.transform 으로 월드 변환 → XZ 투영.
    /// 폴리곤이 없으면(구 SDK·미인식) 빈 배열 → 호출자가 벽 bbox로 폴백.
    static func floorPolygon(_ room: CapturedRoom) -> [CGPoint] {
        guard let floor = room.floors.max(by: { $0.dimensions.x * $0.dimensions.z < $1.dimensions.x * $1.dimensions.z })
        else { return [] }
        let corners = floor.polygonCorners
        guard corners.count >= 3 else { return [] }
        return corners.map { c in
            let w = floor.transform * SIMD4<Float>(c.x, c.y, c.z, 1)
            return CGPoint(x: CGFloat(w.x), y: CGFloat(w.z))
        }
    }

    /// 천장고(m) = 벽 Surface 높이(dimensions.y)의 중앙값. 벽이 없으면 0(미측정).
    /// RoomPlan은 벽을 바닥~천장 전체 높이로 잡으므로 실측 천장고에 근접한다.
    static func estimateCeiling(_ room: CapturedRoom) -> Double {
        let hs = room.walls.map { Double($0.dimensions.y) }.filter { $0 > 1.5 && $0 < 5 }.sorted()
        guard !hs.isEmpty else { return 0 }
        return hs[hs.count / 2]
    }

    // MARK: - Export (JSON / USDZ / PLY + 리포트)

    private func exportAll(_ room: CapturedRoom) {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]

        // 이전 스캔의 잔존 파일 먼저 제거 — export가 실패해도 saveRoomPlan이
        // 옛 스캔의 usdz/json을 새 스캔 것으로 오귀속하지 않게.
        for name in ["roomplan_capturedroom.json", "roomplan_room.usdz"] {
            try? FileManager.default.removeItem(at: docs.appendingPathComponent(name))
        }

        // (1) CapturedRoom → JSON (Codable). 다운스트림 어댑터 입력.
        do {
            let enc = JSONEncoder(); enc.outputFormatting = [.prettyPrinted, .sortedKeys]
            let url = docs.appendingPathComponent("roomplan_capturedroom.json")
            try enc.encode(room).write(to: url)
            exportedJSON = url.path
        } catch { exportedJSON = "JSON 실패: \(error.localizedDescription)" }

        // (2) USDZ (시각화/검증용)
        do {
            let url = docs.appendingPathComponent("roomplan_room.usdz")
            try room.export(to: url)
            exportedUSDZ = url.path
        } catch { exportedUSDZ = "USDZ 실패: \(error.localizedDescription)" }

        // (3) 듀얼트랙 산출물: 메시 정점 PLY (기존 PLYExporter 재사용)
        if !meshVertices.isEmpty {
            if let url = PLYExporter.export(featurePoints: [], meshPoints: meshVertices,
                                            filename: "roomplan_spike_mesh") {
                exportedPLY = url.path
            }
        }

        // (3.5) '내 스캔' 영구 등록 — 고정 파일명 export만으로는 다음 스캔이
        // 덮어써서 저장이 안 되는 것처럼 보였음.
        lastSavedScanID = ScanStore.shared.saveRoomPlan(
            usdz: docs.appendingPathComponent("roomplan_room.usdz"),
            roomJSON: docs.appendingPathComponent("roomplan_capturedroom.json"))

        // (4) 스파이크 측정 리포트 JSON
        do {
            let report: [String: Any] = [
                "metric1_coexist": [
                    "sampledFrames": sampledFrames, "depthFrames": depthFrames,
                    "meshFrames": meshFrames, "bothFrames": bothFrames,
                    "coexistRatio": coexistRatio,
                    "GO_기준": "bothFrames/sampledFrames >= 0.90",
                ],
                "metric2_semantic": [
                    "walls": wallCount, "doors": doorCount, "windows": windowCount,
                    "openings": openingCount, "objects": objectCount,
                    "objectsByCategory": objectsByCategory,
                ],
                "metric3_dimensions": [
                    "floorAreaM2": floorAreaM2, "wallLengths_m": wallLengths,
                    "비교": "줄자 실측과 대조 → 오차 <=5% 면 대략견적 채택 가능",
                ],
                "meshSnapshotPoints": meshVertices.count,
            ]
            let data = try JSONSerialization.data(withJSONObject: report,
                                                  options: [.prettyPrinted, .sortedKeys])
            let url = docs.appendingPathComponent("roomplan_spike_report.json")
            try data.write(to: url)
        } catch { /* 리포트 저장 실패는 무시 */ }
    }

    private func buildReport() -> String {
        let pct = String(format: "%.0f", coexistRatio * 100)
        let go1 = coexistRatio >= 0.90 ? "GO ✅(동시 듀얼트랙)" : "폴백 ⚠️(릴레이 검토)"
        let cats = objectsByCategory.sorted { $0.value > $1.value }
            .map { "\($0.key) \($0.value)" }.joined(separator: ", ")
        return """
        ── RoomPlan 스파이크 측정 ──
        [#1 동시 수집] 메시+depth 동시 프레임 \(bothFrames)/\(sampledFrames) = \(pct)%  → \(go1)
        [#2 시맨틱] 벽 \(wallCount) · 문 \(doorCount) · 창 \(windowCount) · 개구부 \(openingCount) · 가구 \(objectCount)
                  가구분류: \(cats.isEmpty ? "없음" : cats)
        [#3 치수] 바닥면적 \(String(format: "%.2f", floorAreaM2))㎡ · 벽 \(wallLengths.count)개
                  벽길이(m): \(wallLengths.map { String(format: "%.2f", $0) }.joined(separator: ", "))
                  → 줄자 실측과 대조해 오차 ≤5% 확인
        산출물: JSON/USDZ/PLY + report.json (앱 Documents)
        """
    }

    // CapturedRoom.Object.Category → 한글 라벨 (16종)
    static func categoryName(_ c: CapturedRoom.Object.Category) -> String {
        switch c {
        case .storage: return "수납장"
        case .refrigerator: return "냉장고"
        case .stove: return "스토브"
        case .bed: return "침대"
        case .sink: return "싱크대"
        case .washerDryer: return "세탁/건조기"
        case .toilet: return "변기"
        case .bathtub: return "욕조"
        case .oven: return "오븐"
        case .dishwasher: return "식기세척기"
        case .table: return "테이블"
        case .sofa: return "소파"
        case .chair: return "의자"
        case .fireplace: return "벽난로"
        case .stairs: return "계단"
        case .television: return "TV"
        @unknown default: return "기타"
        }
    }
}

// MARK: - RoomCaptureSessionDelegate

@available(iOS 17.0, *)
extension RoomPlanSpikeManager: RoomCaptureSessionDelegate {

    // 라이브 시맨틱 카운트(스캔 중 실시간 피드백)
    nonisolated func captureSession(_ session: RoomCaptureSession, didUpdate room: CapturedRoom) {
        let w = room.walls.count, d = room.doors.count, win = room.windows.count
        let op = room.openings.count, ob = room.objects.count
        Task { @MainActor in
            self.wallCount = w; self.doorCount = d; self.windowCount = win
            self.openingCount = op; self.objectCount = ob
        }
    }

    // 스캔 종료 → 원시 데이터 수신 → RoomBuilder 최종 처리
    nonisolated func captureSession(_ session: RoomCaptureSession,
                                    didEndWith data: CapturedRoomData, error: Error?) {
        if let error {
            Task { @MainActor in self.status = "스캔 종료 오류: \(error.localizedDescription)" }
            return
        }
        Task { await self.process(data) }
    }
}

// MARK: - 저장된 RoomPlan 스캔 → 평면도 재생성 ('내 스캔'에서 오프라인 보기)

@available(iOS 17.0, *)
extension PlanData {
    /// '내 스캔'에 저장된 capturedroom.json(CapturedRoom Codable)에서 평면도 생성.
    /// computePlan과 같은 XZ 투영 수식(중복 유지 — 스캔 세션 없이도 동작해야 함).
    /// categoryEN/categoryName이 @MainActor 정적 메서드라 이 함수도 MainActor(UI 호출 전용).
    @MainActor
    static func fromCapturedRoomFile(_ url: URL) -> PlanData? {
        guard let data = try? Data(contentsOf: url),
              let room = try? JSONDecoder().decode(CapturedRoom.self, from: data)
        else { return nil }

        func segs(_ surfaces: [CapturedRoom.Surface]) -> [[CGPoint]] {
            surfaces.map { s in
                let t = s.transform
                let c = t.columns.3
                let half = CGFloat(s.dimensions.x) / 2
                let ax = t.columns.0
                let nrm = (ax.x * ax.x + ax.z * ax.z).squareRoot()
                let ux = nrm > 1e-6 ? CGFloat(ax.x / nrm) : 0
                let uz = nrm > 1e-6 ? CGFloat(ax.z / nrm) : 0
                return [CGPoint(x: CGFloat(c.x) - ux * half, y: CGFloat(c.z) - uz * half),
                        CGPoint(x: CGFloat(c.x) + ux * half, y: CGFloat(c.z) + uz * half)]
            }
        }
        let furn = room.objects.map { o -> (cat: String, ko: String, cx: Double, cz: Double,
                                            w: Double, d: Double, yaw: Double) in
            let t = o.transform
            let yaw = Double(atan2(t.columns.0.z, t.columns.0.x)) * 180 / .pi
            return (cat: RoomPlanSpikeManager.categoryEN(o.category),
                    ko: RoomPlanSpikeManager.categoryName(o.category),
                    cx: Double(t.columns.3.x), cz: Double(t.columns.3.z),
                    w: Double(o.dimensions.x), d: Double(o.dimensions.z), yaw: yaw)
        }
        let ceil = RoomPlanSpikeManager.estimateCeiling(room)
        let fp = RoomPlanSpikeManager.floorPolygon(room)
        return PlanData.fromRoomPlan(walls: segs(room.walls), doors: segs(room.doors),
                                     windows: segs(room.windows), furniture: furn,
                                     ceiling: ceil > 0 ? ceil : nil,
                                     floorPolygon: fp.isEmpty ? nil : fp,
                                     doorHeights: room.doors.map { Double($0.dimensions.y) },
                                     windowHeights: room.windows.map { Double($0.dimensions.y) })
    }
}
