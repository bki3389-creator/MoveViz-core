//  PlanMetrics.swift
//  PlanShot — PlanData(벡터 평면도)에서 도면·물량 산출에 쓰는 수치를 뽑는다.
//
//  실별 바닥면적(폴리곤 신발끈), 둘레, 천장고, 문/창 개수·폭, 벽 순면적 등.
//  공내역(BOQ) 엔진은 이 값을 입력으로 쓴다 — 여기서는 "측정"만, 단가/공종은 모름.

import Foundation

struct RoomMetrics {
    var name: String?
    var areaM2: Double = 0            // 바닥(=천장) 면적
    var perimeterM: Double = 0        // 내측 둘레
    var widthM: Double = 0            // 바운딩 가로(X)
    var depthM: Double = 0            // 바운딩 세로(Z)
    var ceilingM: Double = 2.4
    var doorCount = 0
    var windowCount = 0
    var doorWidthM: Double = 0        // 문 폭 합
    var windowWidthM: Double = 0      // 창 폭 합
    var doorAreaM2: Double = 0        // 문 면적 합(실제 높이 or 2.1m)
    var windowAreaM2: Double = 0      // 창 면적 합(실제 높이 or 1.2m)

    /// 벽 총면적(개구부 공제 전) = 둘레 × 천장고
    var wallGrossM2: Double { perimeterM * ceilingM }
    /// 개구부 면적 — RoomPlan이 준 높이 우선, 없으면 문 2.1m·창 1.2m 가정
    var openingM2: Double { doorAreaM2 + windowAreaM2 }
    /// 벽 순면적(도배·페인트 물량 기준)
    var wallNetM2: Double { max(0, wallGrossM2 - openingM2) }
    /// 걸레받이 길이 = 둘레 − 문 폭 (문 앞엔 걸레받이 없음)
    var baseboardM: Double { max(0, perimeterM - doorWidthM) }
    /// 천장 몰딩 길이 = 둘레
    var moldingM: Double { perimeterM }
}

enum PlanMetrics {
    static let doorHeightM = 2.1
    static let windowHeightM = 1.2

    /// 폴리곤 면적(신발끈). 열린 폴리곤도 닫아서 계산.
    static func polygonArea(_ pts: [[Double]]) -> Double {
        let p = pts.filter { $0.count >= 2 }
        guard p.count >= 3 else { return 0 }
        var s = 0.0
        for i in 0..<p.count {
            let a = p[i], b = p[(i + 1) % p.count]
            s += a[0] * b[1] - b[0] * a[1]
        }
        return abs(s) / 2
    }

    static func polygonPerimeter(_ pts: [[Double]]) -> Double {
        let p = pts.filter { $0.count >= 2 }
        guard p.count >= 2 else { return 0 }
        var s = 0.0
        for i in 0..<p.count {
            let a = p[i], b = p[(i + 1) % p.count]
            s += ((a[0] - b[0]) * (a[0] - b[0]) + (a[1] - b[1]) * (a[1] - b[1])).squareRoot()
        }
        return s
    }

    /// 방 하나짜리 평면(RoomPlan 스캔 1회 = 방 1개)의 지표.
    /// 여러 방이 있는 plan.json(서버 메시 경로)은 rooms 합산.
    static func metrics(of plan: PlanData, roomName: String? = nil,
                        ceilingOverride: Double? = nil) -> RoomMetrics {
        var m = RoomMetrics(name: roomName)
        let rooms = (plan.rooms ?? []).filter { ($0.polygon?.count ?? 0) >= 3 }
        if !rooms.isEmpty {
            m.areaM2 = rooms.reduce(0) { $0 + ($1.area_m2 ?? polygonArea($1.polygon ?? [])) }
            m.perimeterM = rooms.reduce(0) { $0 + polygonPerimeter($1.polygon ?? []) }
        } else if let b = plan.boundary, b.count >= 3 {
            m.areaM2 = polygonArea(b)
            m.perimeterM = polygonPerimeter(b)
        }
        if let bb = plan.bounds {
            m.widthM = Double(bb.width); m.depthM = Double(bb.height)
            if m.areaM2 == 0 { m.areaM2 = m.widthM * m.depthM }
            if m.perimeterM == 0 { m.perimeterM = 2 * (m.widthM + m.depthM) }
        }
        let scanned = (plan.ceil_y ?? 2.4) - (plan.floor_y ?? 0)
        m.ceilingM = ceilingOverride ?? (scanned > 1.8 && scanned < 4.5 ? scanned : 2.4)
        for op in plan.allOpenings {
            let w = op.width ?? {
                guard let s = op.span, s.count >= 2 else { return 0.0 }
                return abs(s[1] - s[0])
            }()
            if op.type == "window" {
                m.windowCount += 1; m.windowWidthM += w
                m.windowAreaM2 += w * (op.height ?? windowHeightM)
            } else {
                m.doorCount += 1; m.doorWidthM += w
                m.doorAreaM2 += w * (op.height ?? doorHeightM)
            }
        }
        return m
    }
}

// MARK: - 치수 보정 적용

extension PlanData {
    /// 레이저 보정(축별 스케일)을 좌표 전체에 적용한 새 PlanData.
    /// 원점은 bounds.minX/minY — 방 좌상단 기준으로 늘리고 줄인다.
    func applying(_ c: PlanCorrection) -> PlanData {
        guard c.isApplied else { return self }
        let ox = Double(bounds?.minX ?? 0), oz = Double(bounds?.minY ?? 0)
        func sx(_ x: Double) -> Double { ox + (x - ox) * c.scaleX }
        func sz(_ z: Double) -> Double { oz + (z - oz) * c.scaleZ }
        func pt(_ p: [Double]) -> [Double] { p.count >= 2 ? [sx(p[0]), sz(p[1])] : p }
        func pts(_ ps: [[Double]]?) -> [[Double]]? { ps?.map(pt) }

        let xw2 = xw?.map { w in
            PlanWall(pos: w.pos.map(sx), segs: w.segs?.map { $0.count >= 2 ? [sz($0[0]), sz($0[1])] : $0 },
                     presence: w.presence, cls: w.cls) }
        let zw2 = zw?.map { w in
            PlanWall(pos: w.pos.map(sz), segs: w.segs?.map { $0.count >= 2 ? [sx($0[0]), sx($0[1])] : $0 },
                     presence: w.presence, cls: w.cls) }
        func ops(_ os: [PlanOpening]?) -> [PlanOpening]? {
            os?.map { o in
                let alongX = o.wall_dir == "z"      // 가로벽(z=pos): 스팬은 x축
                let span2 = o.span?.map { alongX ? sx($0) : sz($0) }
                let wp2 = o.wall_pos.map { alongX ? sz($0) : sx($0) }
                let w2: Double? = span2.flatMap { $0.count >= 2 ? abs($0[1] - $0[0]) : o.width }
                return PlanOpening(type: o.type, wall_dir: o.wall_dir, wall_pos: wp2,
                                   span: span2, width: w2, center: o.center.map(pt), height: o.height)
            }
        }
        let rooms2 = rooms?.map { r in
            let poly = pts(r.polygon)
            return PlanRoom(id: r.id, polygon: poly,
                            area_m2: poly.map(PlanMetrics.polygonArea) ?? r.area_m2,
                            center: r.center.map(pt), name: r.name) }
        let furn = { (fs: [PlanFurniture]?) -> [PlanFurniture]? in
            fs?.map { f in PlanFurniture(obb: pts(f.obb), polygon: pts(f.polygon), category: f.category,
                                         category_ko: f.category_ko, yaw_deg: f.yaw_deg, score: f.score) }
        }
        let ceil = c.ceilingM.map { ($0 + (floor_y ?? 0)) } ?? ceil_y
        return PlanData(source: source, floor_y: floor_y, ceil_y: ceil,
                        boundary: pts(boundary), xw: xw2, zw: zw2,
                        openings: ops(openings), interior_openings: ops(interior_openings),
                        doors: ops(doors), rooms: rooms2, furniture: furn(furniture),
                        furniture_vision: furn(furniture_vision),
                        furniture_geometry: furn(furniture_geometry))
    }
}
