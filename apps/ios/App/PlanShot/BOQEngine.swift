//  BOQEngine.swift
//  PlanShot — 공내역(물량 산출서) 엔진. 실측 지표(RoomMetrics) → 표준 내역서 서식 행.
//
//  제안서 p6 "산출물 예시" 서식 그대로: No · 공종 · 품명 · 규격 · 단위 · 수량 · 재료비(단가/금액)
//  · 노무비(단가/금액) · 합계 · 비고. 수량은 실측 자동, 단가는 업체 단가표(RateTable) 연동 —
//  "단가 자동 제공은 하지 않습니다"(p8)가 신뢰 설계이므로 기본 단가는 전부 nil(공란).
//
//  산출 규칙(v1, 실무 관행 기준 — 업체별 손율·할증은 BOQSettings로 조정):
//   · 벽지 제거/벽면 도배 = 벽 순면적(둘레×천장고 − 문·창 개구부)  [욕실·발코니 제외]
//   · 천장 도배/바닥재 철거/강마루 = 바닥면적                       [욕실·발코니 제외]
//   · 걸레받이 = 둘레 − 문 폭 ,  천장 몰딩 = 둘레                    [욕실·발코니 제외]
//   · 방문 교체 = 침실·서재·드레스룸·다용도실 방 수(방마다 문 1개소 가정) — 방별 스캔은
//     거실에서 같은 문을 다시 보므로 문 개수 합산은 중복. 욕실문은 욕실 수로 별도.
//   · 욕실 벽타일 = 욕실 벽 순면적 , 바닥타일 = 욕실 바닥면적 , 현관 바닥타일 = 현관 바닥면적

import Foundation

// MARK: - 입력/설정

struct BOQRoomInput {
    let room: PlanRoomRef
    let metrics: RoomMetrics
}

enum RoomKind {
    case living, bedroom, kitchen, bathroom, entrance, balcony, utility, other

    static func classify(_ name: String) -> RoomKind {
        let n = name.lowercased()
        if n.contains("욕실") || n.contains("화장실") || n.contains("bath") { return .bathroom }
        if n.contains("발코니") || n.contains("베란다") || n.contains("balcony") { return .balcony }
        if n.contains("현관") || n.contains("entrance") { return .entrance }
        if n.contains("주방") || n.contains("kitchen") { return .kitchen }
        if n.contains("거실") || n.contains("living") { return .living }
        if n.contains("다용도") || n.contains("세탁") || n.contains("utility") { return .utility }
        if n.contains("침실") || n.contains("안방") || n.contains("방") || n.contains("서재")
            || n.contains("드레스") || n.contains("bed") { return .bedroom }
        return .other
    }

    /// 도배·강마루·몰딩 대상(건식 실)
    var isDry: Bool { self != .bathroom && self != .balcony }
    /// 방문 1개소로 세는 실
    var hasRoomDoor: Bool { self == .bedroom || self == .utility }
}

/// 업체별 손율/할증 — 기본 0%(제안서 예시 수량과 동일). 설정 화면에서 조정.
struct BOQSettings: Codable, Equatable {
    var wallpaperLossPct: Double = 0       // 도배 할증 %
    var floorLossPct: Double = 0           // 바닥재 할증 %
    var tileLossPct: Double = 0            // 타일 할증 %
    var includeDemolition = true
    var includeWallpaper = true
    var includeFlooring = true
    var includeCarpentry = true
    var includeBathroom = true
    var includeEntranceTile = true
    var vatPct: Double = 10                // 합계 아래 참고 표기용
}

/// 단가표 — 품목 키 → 재료비/노무비 단가(원). 업체가 직접 입력하거나 CSV로 가져온다.
struct RateEntry: Codable, Equatable {
    var matUnit: Double? = nil
    var labUnit: Double? = nil
}

struct RateTable: Codable, Equatable {
    var rates: [String: RateEntry] = [:]
    var settings = BOQSettings()
    subscript(key: String) -> RateEntry { rates[key] ?? RateEntry() }
}

@MainActor
final class RateTableStore: ObservableObject {
    static let shared = RateTableStore()
    @Published var table = RateTable() { didSet { persist() } }

    private static var url: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("rate_table.json")
    }
    init() {
        if let d = try? Data(contentsOf: Self.url),
           let t = try? JSONDecoder().decode(RateTable.self, from: d) { table = t }
    }
    private func persist() {
        if let d = try? JSONEncoder().encode(table) { try? d.write(to: Self.url, options: .atomic) }
    }

    /// CSV 가져오기: "품목키,재료비단가,노무비단가" (헤더 허용, 콤마/탭 구분). 반환: 반영된 행 수.
    @discardableResult
    func importCSV(_ text: String) -> Int {
        var n = 0
        for raw in text.split(whereSeparator: { $0 == "\n" || $0 == "\r\n" }) {
            let cols = raw.replacingOccurrences(of: "\t", with: ",").split(separator: ",", omittingEmptySubsequences: false)
                .map { $0.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "\"", with: "") }
            guard cols.count >= 2 else { continue }
            let key = cols[0]
            guard BOQEngine.itemKeys.contains(key) || BOQEngine.itemsByName[key] != nil else { continue }
            let k = BOQEngine.itemsByName[key] ?? key
            let mat = cols.count > 1 ? Double(cols[1].filter { $0.isNumber || $0 == "." }) : nil
            let lab = cols.count > 2 ? Double(cols[2].filter { $0.isNumber || $0 == "." }) : nil
            var e = table.rates[k] ?? RateEntry()
            if let mat { e.matUnit = mat }
            if let lab { e.labUnit = lab }
            table.rates[k] = e
            n += 1
        }
        return n
    }
}

// MARK: - 출력

struct BOQLine: Identifiable {
    let id = UUID()
    let key: String                  // 단가표 키
    let no: String                   // "1.1"
    let trade: String                // 공종
    let item: String                 // 품명
    var spec: String                 // 규격
    let unit: String                 // M2 / M / EA / 식
    var qty: Double
    var matUnit: Double?
    var labUnit: Double?
    var note: String

    var matAmount: Double? { matUnit.map { $0 * qty } }
    var labAmount: Double? { labUnit.map { $0 * qty } }
    var total: Double? {
        if matAmount == nil && labAmount == nil { return nil }
        return (matAmount ?? 0) + (labAmount ?? 0)
    }

    var qtyText: String { BOQFormat.qty(qty, unit: unit) }
    var matUnitText: String { BOQFormat.won(matUnit) }
    var matAmountText: String { BOQFormat.won(matAmount) }
    var labUnitText: String { BOQFormat.won(labUnit) }
    var labAmountText: String { BOQFormat.won(labAmount) }
    var totalText: String { BOQFormat.won(total) }
}

struct BOQDocument {
    var lines: [BOQLine]
    var assumptions: [String]
    var settings: BOQSettings

    var matTotal: Double { lines.compactMap { $0.matAmount }.reduce(0, +) }
    var labTotal: Double { lines.compactMap { $0.labAmount }.reduce(0, +) }
    var grandTotal: Double { matTotal + labTotal }
    var hasAnyPrice: Bool { lines.contains { $0.total != nil } }
    var matTotalText: String { hasAnyPrice ? BOQFormat.won(matTotal) : "" }
    var labTotalText: String { hasAnyPrice ? BOQFormat.won(labTotal) : "" }
    var grandTotalText: String { hasAnyPrice ? BOQFormat.won(grandTotal) : "" }
}

enum BOQFormat {
    static func qty(_ v: Double, unit: String) -> String {
        if unit == "EA" || unit == "식" { return String(Int(v.rounded())) }
        return String(format: "%.1f", v)
    }
    static func won(_ v: Double?) -> String {
        guard let v else { return "" }
        let f = NumberFormatter(); f.numberStyle = .decimal; f.maximumFractionDigits = 0
        return f.string(from: NSNumber(value: v.rounded())) ?? ""
    }
}

// MARK: - 엔진

enum BOQEngine {

    /// 품목 카탈로그 (키, 공종, 품명, 기본 규격, 단위). 키는 단가표 CSV와 연결.
    static let catalog: [(key: String, trade: String, item: String, spec: String, unit: String)] = [
        ("demo_floor",     "철거공사", "바닥재 철거",   "강마루",      "M2"),
        ("demo_wallpaper", "철거공사", "벽지 제거",     "합지 2겹",    "M2"),
        ("demo_ceiling",   "철거공사", "천장지 제거",   "합지",        "M2"),
        ("wp_wall",        "도배공사", "벽면 도배",     "실크벽지",    "M2"),
        ("wp_ceiling",     "도배공사", "천장 도배",     "실크벽지",    "M2"),
        ("fl_laminate",    "바닥공사", "강마루 시공",   "7.5T",        "M2"),
        ("fl_baseboard",   "바닥공사", "걸레받이",      "H80",         "M"),
        ("cp_molding",     "목공사",   "천장 몰딩 교체", "마이너스몰딩", "M"),
        ("cp_door",        "목공사",   "방문 교체",     "ABS 도어",    "EA"),
        ("cp_bathdoor",    "목공사",   "욕실문 교체",   "ABS 도어",    "EA"),
        ("bt_walltile",    "욕실공사", "벽체 타일",     "300×600",     "M2"),
        ("bt_floortile",   "욕실공사", "바닥 타일",     "300×300",     "M2"),
        ("en_floortile",   "타일공사", "현관 바닥 타일", "600×600",     "M2"),
        ("wn_film",        "기타",     "창호 (참고)",    "개소",        "EA"),
    ]
    static var itemKeys: Set<String> { Set(catalog.map { $0.key }) }
    static var itemsByName: [String: String] { Dictionary(uniqueKeysWithValues: catalog.map { ($0.item, $0.key) }) }

    static func build(project: PlanProject, rooms: [BOQRoomInput], rates: RateTable) -> BOQDocument {
        let st = rates.settings
        var q: [String: Double] = [:]
        var notes: [String: [String]] = [:]
        func add(_ key: String, _ v: Double, _ roomName: String) {
            guard v > 0 else { return }
            q[key, default: 0] += v
            notes[key, default: []].append(roomName)
        }

        var bedroomDoors = 0, bathDoors = 0, windows = 0
        for r in rooms {
            let m = r.metrics
            let kind = RoomKind.classify(r.room.name)
            windows += m.windowCount
            switch kind {
            case .bathroom:
                add("bt_walltile", m.wallNetM2, r.room.name)
                add("bt_floortile", m.areaM2, r.room.name)
                bathDoors += 1
            case .balcony:
                break
            case .entrance:
                add("en_floortile", m.areaM2, r.room.name)
                add("demo_wallpaper", m.wallNetM2, r.room.name)
                add("wp_wall", m.wallNetM2, r.room.name)
                add("demo_ceiling", m.areaM2, r.room.name)
                add("wp_ceiling", m.areaM2, r.room.name)
            default:
                add("demo_floor", m.areaM2, r.room.name)
                add("demo_wallpaper", m.wallNetM2, r.room.name)
                add("demo_ceiling", m.areaM2, r.room.name)
                add("wp_wall", m.wallNetM2, r.room.name)
                add("wp_ceiling", m.areaM2, r.room.name)
                add("fl_laminate", m.areaM2, r.room.name)
                add("fl_baseboard", m.baseboardM, r.room.name)
                add("cp_molding", m.moldingM, r.room.name)
                if kind.hasRoomDoor { bedroomDoors += 1 }
            }
        }
        if bedroomDoors > 0 { q["cp_door"] = Double(bedroomDoors) }
        if bathDoors > 0 { q["cp_bathdoor"] = Double(bathDoors) }
        if windows > 0 { q["wn_film"] = Double(windows) }

        // 할증
        func loss(_ key: String) -> Double {
            switch key {
            case "wp_wall", "wp_ceiling": return st.wallpaperLossPct
            case "fl_laminate": return st.floorLossPct
            case "bt_walltile", "bt_floortile", "en_floortile": return st.tileLossPct
            default: return 0
            }
        }
        func enabled(_ trade: String) -> Bool {
            switch trade {
            case "철거공사": return st.includeDemolition
            case "도배공사": return st.includeWallpaper
            case "바닥공사": return st.includeFlooring
            case "목공사": return st.includeCarpentry
            case "욕실공사": return st.includeBathroom
            case "타일공사": return st.includeEntranceTile
            default: return true
            }
        }

        var lines: [BOQLine] = []
        var tradeIdx = 0, lastTrade = ""
        var itemIdx = 0
        for c in catalog {
            guard enabled(c.trade), let v = q[c.key], v > 0 else { continue }
            if c.trade != lastTrade { tradeIdx += 1; itemIdx = 0; lastTrade = c.trade }
            itemIdx += 1
            let l = loss(c.key)
            let qty = v * (1 + l / 100)
            let rate = rates[c.key]
            var note = (c.unit == "EA") ? (c.key == "cp_door" ? "방 수 기준" : (c.key == "wn_film" ? "참고" : "개소 자동 인식")) : "실측 자동"
            if l > 0 { note += String(format: " · 할증 %.0f%%", l) }
            if let rs = notes[c.key], rs.count <= 3, c.unit != "EA" { note += " (" + rs.joined(separator: ",") + ")" }
            lines.append(BOQLine(key: c.key, no: "\(tradeIdx).\(itemIdx)", trade: c.trade, item: c.item,
                                 spec: c.spec, unit: c.unit, qty: qty,
                                 matUnit: rate.matUnit, labUnit: rate.labUnit, note: note))
        }

        var assumptions = [
            "벽 순면적 = 내측 둘레 × 천장고 − 개구부(문 높이 2.1m·창 높이 1.2m 가정, RoomPlan 인식 높이가 있으면 그 값).",
            "도배·강마루·몰딩·걸레받이는 욕실·발코니를 제외한 실에만 산출. 걸레받이 = 둘레 − 문 폭.",
            "방문 교체 수량은 침실·다용도실 등 '방' 수 기준(방마다 문 1개소). 거실 스캔에서 중복 인식된 문은 세지 않음.",
            "벽 두께·마감 두께·몰딩 폭은 미반영. 단가·손율·할증은 업체 기준으로 조정(설정 → 단가표).",
        ]
        if st.vatPct > 0 { assumptions.append(String(format: "부가세 %.0f%% 별도. 제경비(현장관리비·이윤)는 업체 계획에 따름.", st.vatPct)) }
        return BOQDocument(lines: lines, assumptions: assumptions, settings: st)
    }
}
