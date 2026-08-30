//  PlanModel.swift
//  MoveViz — 맥 서버 plan.json(벡터 평면도)의 Codable 모델.
//
//  스키마는 ingest_server.py 산출물 실측 기준. 모든 좌표는 미터, XZ 평면.
//  서버 버전에 따라 없을 수 있는 키(yaw_deg, furniture_vision 등)는 전부 옵셔널.

import Foundation
import CoreGraphics

struct PlanData: Decodable {
    let source: String?
    let floor_y: Double?
    let ceil_y: Double?
    let boundary: [[Double]]?            // 외곽 폴리곤 [[x,z]] — 열려 있을 수 있음
    let xw: [PlanWall]?                  // x=pos 위치의 세로벽(z 구간 segs)
    let zw: [PlanWall]?                  // z=pos 위치의 가로벽(x 구간 segs)
    let openings: [PlanOpening]?
    let interior_openings: [PlanOpening]?
    let doors: [PlanOpening]?
    let rooms: [PlanRoom]?
    let furniture: [PlanFurniture]?      // 활성 가구(비전 우선)
    let furniture_vision: [PlanFurniture]?
    let furniture_geometry: [PlanFurniture]?

    /// 렌더링 범위: boundary 기준, 없으면 벽/방에서 계산.
    var bounds: CGRect? {
        var pts: [[Double]] = boundary ?? []
        if pts.isEmpty { pts = (rooms ?? []).flatMap { $0.polygon ?? [] } }
        if pts.isEmpty {
            for w in xw ?? [] { for s in w.segs ?? [] where s.count >= 2 {
                pts.append([w.pos ?? 0, s[0]]); pts.append([w.pos ?? 0, s[1]]) } }
            for w in zw ?? [] { for s in w.segs ?? [] where s.count >= 2 {
                pts.append([s[0], w.pos ?? 0]); pts.append([s[1], w.pos ?? 0]) } }
        }
        let xs = pts.compactMap { $0.first }
        let zs = pts.compactMap { $0.count > 1 ? $0[1] : nil }
        guard let x0 = xs.min(), let x1 = xs.max(),
              let z0 = zs.min(), let z1 = zs.max(), x1 > x0, z1 > z0 else { return nil }
        return CGRect(x: x0, y: z0, width: x1 - x0, height: z1 - z0)
    }

    var allOpenings: [PlanOpening] {
        (openings ?? []) + (interior_openings ?? []) + (doors ?? [])
    }
}

struct PlanWall: Decodable {
    let pos: Double?
    let segs: [[Double]]?                // [[lo,hi], ...]
    let presence: Double?
    let cls: String?                     // structure / built-in / noise
}

struct PlanOpening: Decodable {
    let type: String?                    // door | window
    let wall_dir: String?                // "x": x=wall_pos 세로벽 / "z": z=wall_pos 가로벽
    let wall_pos: Double?
    let span: [Double]?                  // 벽 진행축상 [lo,hi]
    let width: Double?
    let center: [Double]?
}

struct PlanRoom: Decodable {
    let id: Int?
    let polygon: [[Double]]?
    let area_m2: Double?
    let center: [Double]?
}

struct PlanFurniture: Decodable {
    let obb: [[Double]]?                 // 회전 반영 4코너 [[x,z] × 4]
    let polygon: [[Double]]?             // 지오메트리 경로 산출물 호환
    let category: String?
    let category_ko: String?
    let yaw_deg: Double?
    let score: Double?

    var corners: [[Double]] { obb ?? polygon ?? [] }
}

// MARK: - RoomPlan(온디바이스) → PlanData 어댑터 (축 정렬 포함)

extension PlanData {
    init(boundary: [[Double]]?, xw: [PlanWall]?, zw: [PlanWall]?,
         openings: [PlanOpening]?, rooms: [PlanRoom]?, furniture: [PlanFurniture]?) {
        self.init(source: "roomplan", floor_y: 0, ceil_y: 2.4, boundary: boundary,
                  xw: xw, zw: zw, openings: openings, interior_openings: nil,
                  doors: nil, rooms: rooms, furniture: furniture,
                  furniture_vision: nil, furniture_geometry: nil)
    }

    /// CapturedRoom 벽/문/창(XZ 선분)과 가구를 축 정렬해 PlanData로.
    /// ARKit 월드 yaw는 임의라 그대로 그리면 평면도가 비스듬함 → 벽 길이 가중
    /// ×4 원형 평균으로 지배 축을 찾아 전체를 회전(Manhattan 정렬).
    static func fromRoomPlan(
        walls: [[CGPoint]], doors: [[CGPoint]], windows: [[CGPoint]],
        furniture: [(cat: String, ko: String, cx: Double, cz: Double,
                     w: Double, d: Double, yaw: Double)]
    ) -> PlanData? {
        let wallSegs = walls.filter { $0.count == 2 }
        guard wallSegs.count >= 2 else { return nil }

        var sx = 0.0, sy = 0.0
        for s in wallSegs {
            let dx = Double(s[1].x - s[0].x), dz = Double(s[1].y - s[0].y)
            let len = (dx * dx + dz * dz).squareRoot()
            if len < 0.05 { continue }
            let a4 = 4 * atan2(dz, dx)
            sx += len * cos(a4); sy += len * sin(a4)
        }
        let theta = atan2(sy, sx) / 4
        let c = cos(-theta), sn = sin(-theta)
        func rot(_ x: Double, _ z: Double) -> (x: Double, z: Double) {
            (x * c - z * sn, x * sn + z * c)
        }
        func rotSeg(_ s: [CGPoint]) -> (a: (x: Double, z: Double), b: (x: Double, z: Double)) {
            (rot(Double(s[0].x), Double(s[0].y)), rot(Double(s[1].x), Double(s[1].y)))
        }

        var xw: [PlanWall] = [], zw: [PlanWall] = []
        var minX = Double.infinity, maxX = -Double.infinity
        var minZ = Double.infinity, maxZ = -Double.infinity
        for s in wallSegs {
            let (a, b) = rotSeg(s)
            minX = min(minX, a.x, b.x); maxX = max(maxX, a.x, b.x)
            minZ = min(minZ, a.z, b.z); maxZ = max(maxZ, a.z, b.z)
            if abs(b.x - a.x) >= abs(b.z - a.z) {   // 가로벽: z=pos, x 구간
                zw.append(PlanWall(pos: (a.z + b.z) / 2,
                                   segs: [[min(a.x, b.x), max(a.x, b.x)]],
                                   presence: 1, cls: "structure"))
            } else {                                  // 세로벽: x=pos, z 구간
                xw.append(PlanWall(pos: (a.x + b.x) / 2,
                                   segs: [[min(a.z, b.z), max(a.z, b.z)]],
                                   presence: 1, cls: "structure"))
            }
        }
        guard minX < maxX, minZ < maxZ else { return nil }

        func toOpenings(_ segs: [[CGPoint]], _ type: String) -> [PlanOpening] {
            segs.filter { $0.count == 2 }.map { s in
                let (a, b) = rotSeg(s)
                let alongX = abs(b.x - a.x) >= abs(b.z - a.z)
                let len = ((b.x - a.x) * (b.x - a.x) + (b.z - a.z) * (b.z - a.z)).squareRoot()
                return PlanOpening(
                    type: type,
                    wall_dir: alongX ? "z" : "x",
                    wall_pos: alongX ? (a.z + b.z) / 2 : (a.x + b.x) / 2,
                    span: alongX ? [min(a.x, b.x), max(a.x, b.x)]
                                 : [min(a.z, b.z), max(a.z, b.z)],
                    width: len, center: nil)
            }
        }

        var furn: [PlanFurniture] = []
        for f in furniture {
            let p = rot(f.cx, f.cz)
            let yaw2 = f.yaw - theta * 180 / .pi
            let r = yaw2 * .pi / 180
            let ca = cos(r), sa = sin(r)
            let hw = f.w / 2, hd = f.d / 2
            let obb = [(-hw, -hd), (hw, -hd), (hw, hd), (-hw, hd)].map {
                [p.x + $0.0 * ca - $0.1 * sa, p.z + $0.0 * sa + $0.1 * ca]
            }
            furn.append(PlanFurniture(obb: obb, polygon: nil, category: f.cat,
                                      category_ko: f.ko, yaw_deg: yaw2, score: nil))
        }

        let poly = [[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]]
        let rooms = [PlanRoom(id: 0, polygon: poly,
                              area_m2: (maxX - minX) * (maxZ - minZ), center: nil)]
        return PlanData(boundary: poly, xw: xw, zw: zw,
                        openings: toOpenings(doors, "door") + toOpenings(windows, "window"),
                        rooms: rooms, furniture: furn)
    }
}
