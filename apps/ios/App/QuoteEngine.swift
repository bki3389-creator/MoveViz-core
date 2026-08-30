//  QuoteEngine.swift
//  MoveViz — 3D 스캔 실측 치수 기반 이사 견적 엔진.
//
//  산정 모델 (2026-07 업계 리서치 기반, SERVICE_PLAN.md §5):
//    V = Σ(w×h×d × 포장계수) × 1.35(잡짐/박스)  →  톤수 = V / 5㎥ (1톤 트럭 실효 적재)
//    가격 = 톤수별 기본범위(일반/반포장/포장) × 날짜계수 + 할증(사다리차·엘베·거리·특수품)
//  모든 금액은 만원 단위, "범위"로 제시 (실측 오차·업체 편차 흡수).

import Foundation

// MARK: - 인벤토리 항목

struct QuoteItem: Identifiable, Equatable {
    let id = UUID()
    var category: String        // 영문 카테고리 (검출기 출력)
    var w: Double, h: Double, d: Double   // 실측 m
    var qty: Int = 1
    var fromScan: String? = nil // 출처 스캔 id (수동 추가는 nil)

    var nameKo: String { QuoteEngine.koName(category) }
    var unitVolume: Double { w * h * d * QuoteEngine.packingFactor(category) }
    var volume: Double { unitVolume * Double(qty) }
}

// MARK: - 견적 옵션/결과

struct QuoteOptions {
    var goodDay = false          // 손없는날/주말/말일
    var peakSeason = false       // 성수기(2-4월, 9-11월)
    var noElevator = false       // 엘리베이터 없음(계단)
    var ladderFloor = 0          // 사다리차 사용 층수 (0 = 미사용)
    var distanceKm = 10.0
    var airconWall = 0           // 벽걸이 이전설치 대수
    var airconStand = 0          // 스탠드 이전설치 대수
    var piano = false            // 업라이트 피아노
}

struct PriceRange {
    var lo: Double, hi: Double   // 만원
    static func + (a: PriceRange, b: Double) -> PriceRange { .init(lo: a.lo + b, hi: a.hi + b) }
    static func * (a: PriceRange, f: Double) -> PriceRange { .init(lo: a.lo * f, hi: a.hi * f) }
    var text: String { "\(Int(lo.rounded()))~\(Int(hi.rounded()))만원" }
}

struct QuoteResult {
    var itemVolume: Double       // 가구 합계(포장계수 반영) ㎥
    var totalVolume: Double      // 잡짐 포함 ㎥
    var tons: Double             // 권장 톤수
    var truckLabel: String
    var normal: PriceRange       // 일반(용달+인부)
    var half: PriceRange         // 반포장
    var full: PriceRange         // 포장
    var surchargeNotes: [String] // 할증 내역 설명
}

// MARK: - 엔진

enum QuoteEngine {

    static let koNames: [String: String] = [
        "bed": "침대", "sofa": "소파", "chair": "의자", "table": "테이블",
        "desk": "책상", "counter": "카운터/수납", "toilet": "변기(이전대상 아님)",
        "sink": "세면대(이전대상 아님)", "bathtub": "욕조(이전대상 아님)",
        "refrigerator": "냉장고", "cabinet": "수납장", "wardrobe": "옷장",
        "shelf": "선반", "rack": "선반/랙", "tv": "TV", "monitor": "모니터",
        "appliance": "가전(세탁기 등)", "whiteboard": "화이트보드",
    ]
    static func koName(_ c: String) -> String { koNames[c.lowercased()] ?? c }

    /// 붙박이 설비 — 이사 짐이 아니므로 인벤토리에서 기본 제외.
    static let fixtures: Set<String> = ["toilet", "sink", "bathtub", "counter"]

    static func packingFactor(_ c: String) -> Double {
        switch c.lowercased() {
        case "tv", "monitor": return 1.3                       // 파손주의 포장
        case "refrigerator", "appliance": return 1.2           // 가전
        default: return 1.15                                   // 일반 가구
        }
    }

    /// 치수를 모를 때의 카테고리별 대체 부피(㎥, 포장 후) — 수동 추가 프리셋.
    static let presetDims: [(cat: String, w: Double, h: Double, d: Double)] = [
        ("bed", 1.6, 0.5, 2.1), ("sofa", 1.9, 0.85, 0.9), ("chair", 0.5, 0.9, 0.5),
        ("table", 1.2, 0.75, 0.8), ("desk", 1.2, 0.75, 0.6),
        ("refrigerator", 0.9, 1.8, 0.8), ("appliance", 0.65, 0.9, 0.65),
        ("wardrobe", 2.0, 2.2, 0.6), ("cabinet", 0.8, 1.2, 0.45),
        ("tv", 1.4, 0.8, 0.15), ("shelf", 0.9, 1.8, 0.35),
    ]

    /// 톤수 티어: (톤, 실효 적재 ㎥, 표기)
    static let tiers: [(tons: Double, cap: Double, label: String)] = [
        (1.0, 5, "1톤 트럭"), (1.4, 7, "1.4톤 트럭"), (2.5, 12.5, "2.5톤 트럭"),
        (3.5, 17.5, "3.5톤 트럭"), (5.0, 25, "5톤 트럭"), (6.0, 30, "5톤+ (6톤)"),
        (7.5, 37.5, "7.5톤(대형)"), (10.0, 50, "10톤(대형)"),
    ]

    /// 톤수별 기본가(만원, 서울): (일반 lo,hi / 반포장 / 포장). 6톤 초과는 추정 연장.
    static let priceTable: [Double: (n: PriceRange, h: PriceRange, f: PriceRange)] = [
        1.0: (.init(lo: 15, hi: 30), .init(lo: 20, hi: 40), .init(lo: 30, hi: 50)),
        1.4: (.init(lo: 25, hi: 45), .init(lo: 40, hi: 60), .init(lo: 50, hi: 70)),
        2.5: (.init(lo: 40, hi: 60), .init(lo: 65, hi: 85), .init(lo: 80, hi: 100)),
        3.5: (.init(lo: 55, hi: 75), .init(lo: 75, hi: 100), .init(lo: 90, hi: 120)),
        5.0: (.init(lo: 70, hi: 100), .init(lo: 85, hi: 120), .init(lo: 95, hi: 150)),
        6.0: (.init(lo: 90, hi: 130), .init(lo: 110, hi: 170), .init(lo: 120, hi: 200)),
        7.5: (.init(lo: 110, hi: 160), .init(lo: 130, hi: 190), .init(lo: 150, hi: 230)),
        10.0: (.init(lo: 140, hi: 200), .init(lo: 170, hi: 240), .init(lo: 200, hi: 300)),
    ]

    static let disclaimers = [
        "본 견적은 3D 스캔 실측 기반 추정치이며, 최종 금액은 업체 방문(실사) 견적 후 확정됩니다.",
        "이사화물 표준약관상 사전 고지 없는 추가요금 청구는 무효입니다. 계약금은 통상 운임의 10%.",
        "취소 위약금(표준약관): 고객 — 전날까지 계약금, 당일 계약금의 2배 / 업체 — 최대 6배.",
        "화물자동차운수사업법 허가 업체인지 확인하세요.",
    ]

    static func quote(items: [QuoteItem], options: QuoteOptions) -> QuoteResult {
        let itemVol = items.reduce(0) { $0 + $1.volume }
        let totalVol = itemVol * 1.35                      // 잡짐/주방/옷 박스 35%
        let tier = tiers.first { totalVol <= $0.cap } ?? tiers[tiers.count - 1]
        let base = priceTable[tier.tons] ?? priceTable[5.0]!

        // 날짜 계수
        var factor = 1.0
        var notes: [String] = []
        if options.goodDay { factor *= 1.15; notes.append("손없는날/주말 +15%") }
        if options.peakSeason { factor *= 1.2; notes.append("성수기(2-4·9-11월) +20%") }

        // 정액 할증(만원)
        var flat = 0.0
        if options.ladderFloor > 0 {
            let f = 12.0 + Double(max(0, options.ladderFloor - 5)) * 1.0
            flat += f; notes.append("사다리차 \(options.ladderFloor)층 +\(Int(f))만")
        }
        if options.noElevator { flat += 15; notes.append("엘리베이터 없음(계단 인력) +15만") }
        if options.distanceKm > 30 {
            let f = ((options.distanceKm - 30) / 100 * 12).rounded()
            flat += f; notes.append("장거리 \(Int(options.distanceKm))km +\(Int(f))만")
        }
        if options.airconWall > 0 { let f = Double(options.airconWall) * 11
            flat += f; notes.append("에어컨 벽걸이 \(options.airconWall)대 +\(Int(f))만") }
        if options.airconStand > 0 { let f = Double(options.airconStand) * 14
            flat += f; notes.append("에어컨 스탠드 \(options.airconStand)대 +\(Int(f))만") }
        if options.piano { flat += 25; notes.append("피아노(업라이트) +25만") }

        func adj(_ p: PriceRange) -> PriceRange { p * factor + flat }
        return QuoteResult(
            itemVolume: itemVol, totalVolume: totalVol,
            tons: tier.tons, truckLabel: tier.label,
            normal: adj(base.n), half: adj(base.h), full: adj(base.f),
            surchargeNotes: notes)
    }
}
