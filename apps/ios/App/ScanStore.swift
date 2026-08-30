//  ScanStore.swift
//  MoveViz — 스캔(메시 OBJ + RGB 키프레임)을 폰에 영구 저장하고 나중에 불러온다.
//  업로드 실패해도 스캔이 날아가지 않게, 완료 즉시 Documents/savedScans/<id>/ 로 복사.

import Foundation

struct SavedScan: Identifiable {
    let id: String          // 폴더명(타임스탬프)
    let folder: URL
    let date: Date
    let vertexCount: Int
    let keyframeCount: Int

    var meshURL: URL { folder.appendingPathComponent("scan.obj") }
    var usdzURL: URL { folder.appendingPathComponent("scan.usdz") }          // RoomPlan
    var texturedURL: URL { folder.appendingPathComponent("textured.usdz") } // 서버 정점색
    var planURL: URL { folder.appendingPathComponent("plan.json") }         // 서버 벡터 평면도
    var furnitureURL: URL { folder.appendingPathComponent("furniture.json") } // 가구 실측(치수·중심)
    var roomJSONURL: URL { folder.appendingPathComponent("roomplan.json") }
    var keyframesURL: URL { folder.appendingPathComponent("keyframes") }
    var hasMesh: Bool { FileManager.default.fileExists(atPath: meshURL.path) }
    var hasUSDZ: Bool { FileManager.default.fileExists(atPath: usdzURL.path) }
    var hasTextured: Bool { FileManager.default.fileExists(atPath: texturedURL.path) }
    var hasPlan: Bool { FileManager.default.fileExists(atPath: planURL.path) }
    var hasFurniture: Bool { FileManager.default.fileExists(atPath: furnitureURL.path) }
    var hasRoomJSON: Bool { FileManager.default.fileExists(atPath: roomJSONURL.path) }
    var hasKeyframes: Bool {
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: keyframesURL.path, isDirectory: &isDir) && isDir.boolValue
    }
    /// 3D 보기 우선순위: 서버 텍스처드 > RoomPlan usdz > LiDAR obj
    var bestModelURL: URL? {
        if hasTextured { return texturedURL }
        if hasUSDZ { return usdzURL }
        if hasMesh { return meshURL }
        return nil
    }
}

@MainActor
final class ScanStore: ObservableObject {
    static let shared = ScanStore()
    @Published private(set) var scans: [SavedScan] = []

    private let fm = FileManager.default
    static var root: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("savedScans", isDirectory: true)
    }

    init() { try? fm.createDirectory(at: Self.root, withIntermediateDirectories: true); reload() }

    func reload() {
        let dirs = (try? fm.contentsOfDirectory(at: Self.root, includingPropertiesForKeys: nil)) ?? []
        scans = dirs.compactMap { load($0) }.sorted { $0.date > $1.date }
    }

    private func load(_ folder: URL) -> SavedScan? {
        guard (try? folder.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true else { return nil }
        let id = folder.lastPathComponent
        var date = Date.distantPast, verts = 0, kf = 0
        if let data = try? Data(contentsOf: folder.appendingPathComponent("meta.json")),
           let m = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            verts = (m["vertices"] as? Int) ?? 0
            kf = (m["keyframes"] as? Int) ?? 0
            if let t = m["date"] as? Double { date = Date(timeIntervalSince1970: t) }
        }
        if date == .distantPast {
            date = (try? folder.resourceValues(forKeys: [.creationDateKey]))?.creationDate ?? Date()
        }
        return SavedScan(id: id, folder: folder, date: date, vertexCount: verts, keyframeCount: kf)
    }

    /// 메시 OBJ + 키프레임 폴더를 영구 저장소로 복사. 반환: 저장 id(실패 시 nil).
    @discardableResult
    func save(meshURL: URL?, keyframesFolder: URL?, vertexCount: Int) -> String? {
        let id = Self.timestamp()
        let dest = Self.root.appendingPathComponent(id, isDirectory: true)
        do {
            try fm.createDirectory(at: dest, withIntermediateDirectories: true)
            var kfCount = 0
            if let mesh = meshURL, fm.fileExists(atPath: mesh.path) {
                try? fm.removeItem(at: dest.appendingPathComponent("scan.obj"))
                try fm.copyItem(at: mesh, to: dest.appendingPathComponent("scan.obj"))
            }
            if let kf = keyframesFolder, fm.fileExists(atPath: kf.path) {
                let kfDest = dest.appendingPathComponent("keyframes", isDirectory: true)
                try? fm.removeItem(at: kfDest)
                try fm.copyItem(at: kf, to: kfDest)
                kfCount = ((try? fm.contentsOfDirectory(atPath: kfDest.path)) ?? []).filter { $0.hasSuffix(".jpg") }.count
            }
            let meta: [String: Any] = ["vertices": vertexCount, "keyframes": kfCount, "date": Date().timeIntervalSince1970]
            try? JSONSerialization.data(withJSONObject: meta).write(to: dest.appendingPathComponent("meta.json"))
            reload()
            return id
        } catch {
            try? fm.removeItem(at: dest)
            return nil
        }
    }

    /// RoomPlan 결과(usdz + capturedroom JSON) 영구 저장 — 이전엔 고정 파일명
    /// 덮어쓰기만 되고 '내 스캔'에 등록되지 않아 저장이 안 되는 것처럼 보였음.
    @discardableResult
    func saveRoomPlan(usdz: URL?, roomJSON: URL?) -> String? {
        let id = Self.timestamp()
        let dest = Self.root.appendingPathComponent(id, isDirectory: true)
        do {
            try fm.createDirectory(at: dest, withIntermediateDirectories: true)
            if let u = usdz, fm.fileExists(atPath: u.path) {
                try fm.copyItem(at: u, to: dest.appendingPathComponent("scan.usdz"))
            }
            if let j = roomJSON, fm.fileExists(atPath: j.path) {
                try fm.copyItem(at: j, to: dest.appendingPathComponent("roomplan.json"))
            }
            let meta: [String: Any] = ["vertices": 0, "keyframes": 0,
                                       "date": Date().timeIntervalSince1970,
                                       "kind": "roomplan"]
            try? JSONSerialization.data(withJSONObject: meta)
                .write(to: dest.appendingPathComponent("meta.json"))
            reload()
            return id
        } catch {
            try? fm.removeItem(at: dest)
            return nil
        }
    }

    /// 서버 벡터 평면도(plan.json)를 스캔 폴더에 보관 — '내 스캔'에서 오프라인 평면도 보기.
    func attachPlan(_ data: Data, toScanID id: String) {
        let dir = Self.root.appendingPathComponent(id, isDirectory: true)
        guard fm.fileExists(atPath: dir.path) else { return }
        try? data.write(to: dir.appendingPathComponent("plan.json"))
        reload()
    }

    /// 가구 실측(furniture_vision.json)을 스캔 폴더에 보관 — 인벤토리/견적 입력.
    func attachFurniture(_ data: Data, toScanID id: String) {
        let dir = Self.root.appendingPathComponent(id, isDirectory: true)
        guard fm.fileExists(atPath: dir.path) else { return }
        try? data.write(to: dir.appendingPathComponent("furniture.json"))
        reload()
    }

    /// 서버가 만든 정점색(텍스처드) USDZ를 해당 스캔 폴더에 보관 — 오프라인 3D 보기용.
    func attachTextured(usdz: URL, toScanID id: String) {
        let dest = Self.root.appendingPathComponent(id, isDirectory: true)
            .appendingPathComponent("textured.usdz")
        guard fm.fileExists(atPath: Self.root.appendingPathComponent(id).path) else { return }
        try? fm.removeItem(at: dest)
        try? fm.copyItem(at: usdz, to: dest)
        reload()
    }

    func delete(_ scan: SavedScan) {
        try? fm.removeItem(at: scan.folder)
        reload()
    }

    private static func timestamp() -> String {
        let f = DateFormatter(); f.dateFormat = "yyyyMMdd_HHmmss"; return f.string(from: Date())
    }
}
