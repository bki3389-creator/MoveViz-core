//  ProjectStore.swift
//  PlanShot — 현장(세대) 단위 프로젝트: 방(스캔) 목록 + 고객/주소 메타 + 치수 보정.
//
//  제안서 흐름: 현장 → 방마다 스캔 → 세대 합산(㎡·평·천장고) → 도면 PDF → 카톡.
//  스캔 파일 자체는 ScanStore(Documents/savedScans/<id>/)가 소유하고, 여기서는
//  "어느 스캔이 어느 현장의 어느 방인가"만 Documents/projects.json 에 기록한다.

import Foundation

// MARK: - 모델

/// 레이저 실측값으로 도면을 보정한 기록 (제안서 p11 "현장 레이저 값 스팟 보정").
/// v1은 방 단위 축별 균일 스케일 — 벽 하나만 고치는 정밀 보정은 후속.
struct PlanCorrection: Codable, Equatable {
    var scaleX: Double = 1            // 가로(X) 배율 = 레이저 / 스캔
    var scaleZ: Double = 1            // 세로(Z) 배율
    var ceilingM: Double? = nil       // 천장고 수동 입력(m) — nil이면 스캔값
    var laserWidthM: Double? = nil    // 입력한 레이저 가로(m) — 도면 표기·이력용
    var laserDepthM: Double? = nil
    var note: String = ""

    var isIdentity: Bool { scaleX == 1 && scaleZ == 1 && ceilingM == nil }
    var isApplied: Bool { !isIdentity }
}

struct PlanRoomRef: Codable, Identifiable, Equatable {
    var id: String = UUID().uuidString
    var name: String                  // 침실1 · 거실 · 욕실 …
    var scanID: String                // SavedScan.id (savedScans/<id>)
    var order: Int = 0
    var correction = PlanCorrection()
    var layout: [LayoutItem]? = nil   // 배치안(탑뷰 레이아웃 편집기). nil = 스캔 인식 가구 그대로
    var createdAt: Date = Date()
}

struct PlanProject: Codable, Identifiable, Equatable {
    var id: String = UUID().uuidString
    var name: String                  // 현장명 (예: "래미안 101동 1203호")
    var clientName: String = ""       // 고객명
    var company: String = ""          // 우리 업체명 (도면 타이틀블록)
    var address: String = ""
    var complex: String = ""          // 단지명 — as-built DB 재상담 키
    var dong: String = ""
    var ho: String = ""
    var pyeongType: String = ""       // 분양 평형 표기 (예: "84A")
    var rooms: [PlanRoomRef] = []
    var createdAt: Date = Date()
    var updatedAt: Date = Date()

    var sortedRooms: [PlanRoomRef] { rooms.sorted { $0.order < $1.order } }
}

/// 세대 합산 결과 — ProjectDetail 상단 카드와 PDF 요약 페이지가 쓴다.
struct ProjectSummary {
    var roomCount = 0
    var areaM2: Double = 0            // 방 바닥면적 합
    var ceilingM: Double? = nil       // 방 천장고 평균(보정값 우선)
    var doors = 0
    var windows = 0
    var furniture = 0

    var pyeong: Double { PlanUnits.pyeong(areaM2) }
}

enum PlanUnits {
    /// 1평 = 3.305785㎡ → ㎡ × 0.3025
    static func pyeong(_ m2: Double) -> Double { m2 * 0.3025 }
    static func mm(_ meters: Double) -> Int { Int((meters * 1000).rounded()) }
    static func mmText(_ meters: Double) -> String {
        let f = NumberFormatter(); f.numberStyle = .decimal
        return f.string(from: NSNumber(value: mm(meters))) ?? "\(mm(meters))"
    }
}

// MARK: - 저장소

@MainActor
final class ProjectStore: ObservableObject {
    static let shared = ProjectStore()

    @Published private(set) var projects: [PlanProject] = []

    static let roomPresets = ["거실", "주방", "침실1", "침실2", "침실3", "안방",
                              "욕실1", "욕실2", "현관", "발코니", "다용도실", "드레스룸", "기타"]

    private static var fileURL: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("projects.json")
    }

    init() { load() }

    func load() {
        guard let data = try? Data(contentsOf: Self.fileURL) else { projects = []; return }
        let dec = JSONDecoder(); dec.dateDecodingStrategy = .iso8601
        projects = (try? dec.decode([PlanProject].self, from: data)) ?? []
        projects.sort { $0.updatedAt > $1.updatedAt }
    }

    private func persist() {
        let enc = JSONEncoder(); enc.dateEncodingStrategy = .iso8601
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? enc.encode(projects) {
            try? data.write(to: Self.fileURL, options: .atomic)
        }
    }

    // MARK: CRUD

    @discardableResult
    func create(_ p: PlanProject) -> PlanProject {
        var np = p
        if np.name.trimmingCharacters(in: .whitespaces).isEmpty {
            np.name = Self.defaultName()
        }
        projects.insert(np, at: 0)
        persist()
        return np
    }

    func update(_ p: PlanProject) {
        guard let i = projects.firstIndex(where: { $0.id == p.id }) else { return }
        var np = p; np.updatedAt = Date()
        projects[i] = np
        projects.sort { $0.updatedAt > $1.updatedAt }
        persist()
    }

    func delete(_ p: PlanProject) {
        projects.removeAll { $0.id == p.id }
        persist()
    }

    func project(id: String) -> PlanProject? { projects.first { $0.id == id } }

    // MARK: 방

    /// 스캔 완료 → 현장에 방으로 등록. 같은 scanID가 이미 있으면 이름만 갱신.
    @discardableResult
    func addRoom(to projectID: String, name: String, scanID: String) -> PlanRoomRef? {
        guard var p = project(id: projectID) else { return nil }
        if let i = p.rooms.firstIndex(where: { $0.scanID == scanID }) {
            p.rooms[i].name = name
            update(p)
            return p.rooms[i]
        }
        let room = PlanRoomRef(name: name, scanID: scanID,
                               order: (p.rooms.map { $0.order }.max() ?? -1) + 1)
        p.rooms.append(room)
        update(p)
        return room
    }

    func updateRoom(_ room: PlanRoomRef, in projectID: String) {
        guard var p = project(id: projectID),
              let i = p.rooms.firstIndex(where: { $0.id == room.id }) else { return }
        p.rooms[i] = room
        update(p)
    }

    func removeRoom(_ room: PlanRoomRef, from projectID: String) {
        guard var p = project(id: projectID) else { return }
        p.rooms.removeAll { $0.id == room.id }
        update(p)
    }

    /// 다음 방 이름 추천 — 이미 쓴 프리셋은 건너뜀.
    func suggestedRoomName(for projectID: String) -> String {
        let used = Set(project(id: projectID)?.rooms.map { $0.name } ?? [])
        return Self.roomPresets.first { !used.contains($0) } ?? "방\(used.count + 1)"
    }

    private static func defaultName() -> String {
        let f = DateFormatter(); f.dateFormat = "M/d 현장"; return f.string(from: Date())
    }
}
