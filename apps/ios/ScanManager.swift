import ARKit
import RealityKit
import Combine
import simd

// MARK: - Data Models

struct ScanPoint {
    let position: SIMD3<Float>
    let color: SIMD3<UInt8>
}

struct GridCell: Hashable {
    let x: Int
    let y: Int
}

struct GridCell3D: Hashable {
    let x: Int
    let y: Int
    let z: Int
}

enum ScanPhase: String {
    case ready = "ready"
    case scanning = "scanning"
    case done = "done"
}

// MARK: - ScanManager

@MainActor
class ScanManager: NSObject, ObservableObject {
    // MARK: Published State
    @Published var phase: ScanPhase = .ready
    @Published var pointCount: Int = 0
    @Published var meshVertexCount: Int = 0
    @Published var coveragePercent: Double = 0
    @Published var estimatedWidth: Float = 0
    @Published var estimatedDepth: Float = 0
    @Published var statusMessage: String = "Start를 눌러 스캔을 시작하세요"
    @Published var hasLiDAR: Bool = false
    @Published var cameraX: Float = 0
    @Published var cameraZ: Float = 0
    @Published var cameraYaw: Float = 0
    @Published var gridData: [GridCell: Int] = [:]
    @Published var gridMinX: Int = 0
    @Published var gridMaxX: Int = 0
    @Published var gridMinY: Int = 0
    @Published var gridMaxY: Int = 0
    @Published var scanDuration: TimeInterval = 0

    // MARK: Internal State
    private(set) var points: [ScanPoint] = []
    private var meshPoints: [SIMD3<Float>] = []
    private var spatialHash = Set<GridCell3D>()
    // UI 발화 폭풍 방지: 포인트마다 @Published를 만지지 않고 여기(비발행)에
    // 누적한 뒤 0.25s마다 한 번에 플러시.
    private var workGrid: [GridCell: Int] = [:]
    private var wMinX = 0, wMaxX = 0, wMinY = 0, wMaxY = 0
    private var lastFlush = Date.distantPast
    private let dedupeRes: Float = 0.03   // 3cm dedup grid
    private let gridRes: Float = 0.15     // 15cm coverage grid
    private var frameCount: Int = 0
    private let sampleRate: Int = 3       // process every Nth frame
    private var scanStartTime: Date?
    private var timer: Timer?

    // 텍스처용 RGB 키프레임 캡처(메시 위 이미지 매핑 입력). 스캔 중에만 set.
    // nonisolated(unsafe): ARSessionDelegate(백그라운드)에서 직접 record() 호출.
    nonisolated(unsafe) var keyframeRecorder: KeyframeRecorder?

    // 면(faces) 포함 메시 누적 → OBJ export(평면도 파이프라인 입력). 점군 PLY와 별개.
    nonisolated let meshAcc = MeshAccumulator()

    // 델리게이트 큐(백그라운드)에서 읽는 캡처 게이트. Start~Stop 사이에만 true —
    // 이 게이트가 없으면 Stop 이후에도 메시/키프레임이 계속 쌓여 OBJ가 오염된다.
    nonisolated(unsafe) private var capturing = false

    // ARKit 콜백 전용 시리얼 큐. 미설정 시 메인 스레드로 콜백이 와서
    // JPEG 인코딩·메시 복사가 프레임 드랍 → 흐린 키프레임을 만든다.
    nonisolated static let captureQueue = DispatchQueue(label: "moveviz.capture")

    weak var arView: ARView?

    // MARK: - Setup

    func configure(_ arView: ARView) {
        self.arView = arView
        arView.session.delegate = self
        arView.session.delegateQueue = ScanManager.captureQueue
        hasLiDAR = ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
    }

    // MARK: - Scan Control

    func startScan() {
        guard let arView = arView else { return }

        let config = ARWorldTrackingConfiguration()
        config.planeDetection = [.horizontal, .vertical]
        config.environmentTexturing = .automatic

        // LiDAR features (auto-enabled if available)
        if hasLiDAR {
            config.sceneReconstruction = .meshWithClassification
            if ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) {
                config.frameSemantics.insert(.sceneDepth)
            }
        }

        arView.session.run(config, options: [.resetTracking, .removeExistingAnchors])

        // Visual debug overlays
        arView.debugOptions = [.showFeaturePoints]
        if hasLiDAR {
            arView.debugOptions.insert(.showSceneUnderstanding)
        }

        // Reset all state
        points.removeAll()
        meshPoints.removeAll()
        spatialHash.removeAll()
        gridData.removeAll()
        workGrid.removeAll()
        wMinX = 0; wMaxX = 0; wMinY = 0; wMaxY = 0
        lastFlush = .distantPast
        gridMinX = 0; gridMaxX = 0
        gridMinY = 0; gridMaxY = 0
        pointCount = 0
        meshVertexCount = 0
        coveragePercent = 0
        estimatedWidth = 0
        estimatedDepth = 0
        frameCount = 0

        // 텍스처용 RGB 키프레임 캡처 시작(메시 위 이미지 매핑 입력 생성)
        let kr = KeyframeRecorder(name: "lidar_texture")
        kr.reset()
        keyframeRecorder = kr
        meshAcc.reset()   // 면 포함 메시 누적 초기화
        capturing = true

        scanStartTime = Date()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self = self, let start = self.scanStartTime else { return }
                self.scanDuration = Date().timeIntervalSince(start)
            }
        }

        phase = .scanning
        statusMessage = "천천히 움직이며 공간을 스캔하세요"
    }

    func stopScan() {
        capturing = false
        arView?.session.pause()           // 정지 후 카메라·메시 누적 중단
        timer?.invalidate()
        timer = nil
        lastFlush = .distantPast          // 마지막 통계 강제 플러시
        flushStats()
        phase = .done
        _ = keyframeRecorder?.finish()    // poses.json 저장(텍스처 입력 폴더 완성)
        let kf = keyframeRecorder?.count ?? 0
        keyframeRecorder = nil
        let total = pointCount + meshVertexCount
        statusMessage = "스캔 완료! \(total)개 포인트 · RGB 키프레임 \(kf)장(텍스처용)"
    }

    func resetScan() {
        capturing = false
        timer?.invalidate()
        timer = nil
        keyframeRecorder = nil
        arView?.session.pause()
        arView?.debugOptions = []
        points.removeAll()
        meshPoints.removeAll()
        spatialHash.removeAll()
        gridData.removeAll()
        pointCount = 0
        meshVertexCount = 0
        coveragePercent = 0
        estimatedWidth = 0
        estimatedDepth = 0
        scanDuration = 0
        phase = .ready
        statusMessage = "Start를 눌러 스캔을 시작하세요"
    }

    // MARK: - Export

    func exportPLY() -> URL? {
        return PLYExporter.export(
            featurePoints: points,
            meshPoints: meshPoints,
            filename: "moveviz_scan"
        )
    }

    /// 면(faces) 포함 메시를 OBJ로 export → 맥 ingest 서버(평면도 파이프라인) 입력.
    func exportMeshOBJ() -> URL? { meshAcc.exportOBJ() }

    /// 스캔 중 모은 RGB 키프레임 폴더(이미지 매핑/텍스처용). 맥으로 메시와 함께 전송.
    var keyframesFolderURL: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("lidar_texture", isDirectory: true)
    }

    func getAllPointPositions() -> [SIMD3<Float>] {
        var all = points.map { $0.position }
        all.append(contentsOf: meshPoints)
        return all
    }

    // MARK: - Point Processing

    private func processFeaturePoints(_ pointData: [SIMD3<Float>]) {
        var added = 0
        for p in pointData {
            let cell = GridCell3D(
                x: Int(floor(p.x / dedupeRes)),
                y: Int(floor(p.y / dedupeRes)),
                z: Int(floor(p.z / dedupeRes))
            )
            if spatialHash.insert(cell).inserted {
                points.append(ScanPoint(
                    position: p,
                    color: SIMD3<UInt8>(200, 200, 200)
                ))
                updateGrid(p)
                added += 1
            }
        }
        if added > 0 {
            flushStats()
        }
    }

    private func processMeshVertices(_ vertices: [SIMD3<Float>]) {
        var added = 0
        for v in vertices {
            let cell = GridCell3D(
                x: Int(floor(v.x / dedupeRes)),
                y: Int(floor(v.y / dedupeRes)),
                z: Int(floor(v.z / dedupeRes))
            )
            if spatialHash.insert(cell).inserted {
                meshPoints.append(v)
                updateGrid(v)
                added += 1
            }
        }
        if added > 0 {
            flushStats()
        }
    }

    private func updateGrid(_ pos: SIMD3<Float>) {
        // Top-down view: X horizontal, Z depth (Y is up in ARKit)
        // 비발행 작업 상태만 갱신 — @Published 반영은 flushStats()가 배치로.
        let gx = Int(floor(pos.x / gridRes))
        let gy = Int(floor(pos.z / gridRes))
        workGrid[GridCell(x: gx, y: gy), default: 0] += 1

        if workGrid.count <= 1 {
            wMinX = gx; wMaxX = gx
            wMinY = gy; wMaxY = gy
        } else {
            wMinX = min(wMinX, gx)
            wMaxX = max(wMaxX, gx)
            wMinY = min(wMinY, gy)
            wMaxY = max(wMaxY, gy)
        }
    }

    /// @Published 통계 일괄 반영 (0.25s 스로틀) — SwiftUI 재렌더 폭풍 방지.
    private func flushStats() {
        let now = Date()
        guard now.timeIntervalSince(lastFlush) >= 0.25 else { return }
        lastFlush = now
        pointCount = points.count
        meshVertexCount = meshPoints.count
        gridData = workGrid
        gridMinX = wMinX; gridMaxX = wMaxX
        gridMinY = wMinY; gridMaxY = wMaxY
        estimatedWidth = Float(wMaxX - wMinX + 1) * gridRes
        estimatedDepth = Float(wMaxY - wMinY + 1) * gridRes
        let totalCells = max(1, (wMaxX - wMinX + 1) * (wMaxY - wMinY + 1))
        coveragePercent = min(100, Double(workGrid.count) / Double(totalCells) * 100)
    }

    private func updateCamera(_ transform: simd_float4x4) {
        cameraX = transform.columns.3.x
        cameraZ = transform.columns.3.z
        let forward = -transform.columns.2
        cameraYaw = atan2(forward.x, forward.z)
    }
}

// MARK: - ARSessionDelegate

extension ScanManager: ARSessionDelegate {

    nonisolated func session(_ session: ARSession, didUpdate frame: ARFrame) {
        guard capturing else { return }
        // 텍스처용 RGB 키프레임(자체 모션 throttle). 점군 throttle보다 먼저.
        keyframeRecorder?.record(frame)

        // Throttle: only process every Nth frame
        let count = OSAtomicIncrement32(&_frameCounter)
        guard count % Int32(3) == 0 else { return }

        let transform = frame.camera.transform

        // Copy feature points (ARPointCloud.points is already a Swift array)
        var copiedPoints: [SIMD3<Float>] = []
        if let fp = frame.rawFeaturePoints {
            copiedPoints = fp.points
        }

        Task { @MainActor [weak self] in
            guard let self = self, self.phase == .scanning else { return }
            self.updateCamera(transform)
            if !copiedPoints.isEmpty {
                self.processFeaturePoints(copiedPoints)
            }
        }
    }

    nonisolated func session(_ session: ARSession, didAdd anchors: [ARAnchor]) {
        processMeshAnchors(anchors)
    }

    nonisolated func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) {
        processMeshAnchors(anchors)
    }

    nonisolated private func processMeshAnchors(_ anchors: [ARAnchor]) {
        guard capturing else { return }
        for anchor in anchors {
            guard let meshAnchor = anchor as? ARMeshAnchor else { continue }
            meshAcc.update(meshAnchor)   // 면 포함 메시 누적(OBJ export용)
            let geometry = meshAnchor.geometry
            let vertexSource = geometry.vertices
            let transform = meshAnchor.transform

            // Sample every 10th vertex for performance
            var vertices: [SIMD3<Float>] = []
            let step = max(1, vertexSource.count / 200)
            for i in stride(from: 0, to: vertexSource.count, by: step) {
                let byteOffset = vertexSource.offset + vertexSource.stride * i
                let ptr = vertexSource.buffer.contents().advanced(by: byteOffset)
                let x = ptr.load(as: Float.self)
                let y = ptr.advanced(by: 4).load(as: Float.self)
                let z = ptr.advanced(by: 8).load(as: Float.self)
                let local = SIMD4<Float>(x, y, z, 1)
                let world = transform * local
                vertices.append(SIMD3<Float>(world.x, world.y, world.z))
            }

            Task { @MainActor [weak self] in
                guard let self = self, self.phase == .scanning else { return }
                self.processMeshVertices(vertices)
            }
        }
    }
}

// Top-level atomic counter for nonisolated access
private var _frameCounter: Int32 = 0
