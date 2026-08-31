//  DXFExporter.swift
//  PlanShot — 실측 평면 → CAD(DXF R12/AC1009) 내보내기. 설계 툴(AutoCAD·캐드마스터·스케치업) 직결.
//
//  R12를 고른 이유: HANDLE·CLASSES·OBJECTS 섹션이 필요 없어 손으로 써도 모든 CAD가 연다.
//  LWPOLYLINE은 R13+ 전용이라 POLYLINE/VERTEX/SEQEND 로 쓴다. 치수는 DIMENSION 블록 대신
//  LINE+TEXT(치수선·틱·mm 라벨)로 그려 어떤 뷰어에서도 같은 모양이 나오게 한다.
//  단위 mm. 한글 텍스트는 CP949(ANSI_949)로 인코딩하고 $DWGCODEPAGE 에 선언.
//  방마다 좌표계가 다르므로(방별 스캔) 방들을 X축으로 3m 간격 나열한다.
//
//  레이어(AIA 관례): A-WALL(외곽 이중선) A-DOOR A-GLAZ(창) A-FURN A-ANNO-DIMS A-ANNO-TEXT A-AREA

import Foundation

struct DXFRoom {
    let name: String
    let plan: PlanData
    let metrics: RoomMetrics
}

enum DXFExporter {
    static let wallT = 0.20          // 벽 두께(m) — README_CAD 결정(200mm 고정)
    static let gap = 3.0             // 방 간 간격(m)

    static func export(project: PlanProject, rooms: [DXFRoom]) -> URL? {
        let df = DateFormatter(); df.dateFormat = "yyMMdd"
        let safe = project.name.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(df.string(from: Date()))_\(safe)_실측평면.dxf")
        try? FileManager.default.removeItem(at: url)
        let text = build(project: project, rooms: rooms)
        // CP949(EUC-KR 확장) 인코딩 — AutoCAD가 $DWGCODEPAGE ANSI_949 로 해석. 실패 시 UTF-8 폴백.
        let cp949 = String.Encoding(rawValue: CFStringConvertEncodingToNSStringEncoding(
            CFStringEncoding(CFStringEncodings.dosKorean.rawValue)))
        // CP949에 없는 문자(— 등)는 '?'로 손실 변환 — UTF-8로 떨어지면 AutoCAD가 한글을 깨뜨린다.
        let data = text.data(using: cp949, allowLossyConversion: true) ?? Data(text.utf8)
        do { try data.write(to: url); return url } catch { return nil }
    }

    // MARK: 본문

    private static func build(project: PlanProject, rooms: [DXFRoom]) -> String {
        var out: [String] = []
        func g(_ code: Int, _ v: String) { out.append("\(code)"); out.append(v) }
        func n(_ v: Double) -> String { String(format: "%.1f", v * 1000) }   // m → mm

        // 전체 범위(EXTMIN/EXTMAX) 계산용
        var minX = Double.infinity, minY = Double.infinity, maxX = -Double.infinity, maxY = -Double.infinity
        func ext(_ x: Double, _ y: Double) { minX = min(minX, x); minY = min(minY, y); maxX = max(maxX, x); maxY = max(maxY, y) }

        var ents: [String] = []
        func e(_ code: Int, _ v: String) { ents.append("\(code)"); ents.append(v) }
        func line(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double, _ layer: String) {
            e(0, "LINE"); e(8, layer)
            e(10, n(x1)); e(20, n(y1)); e(30, "0"); e(11, n(x2)); e(21, n(y2)); e(31, "0")
            ext(x1, y1); ext(x2, y2)
        }
        func poly(_ pts: [(Double, Double)], _ layer: String, closed: Bool) {
            guard pts.count >= 2 else { return }
            e(0, "POLYLINE"); e(8, layer); e(66, "1"); e(70, closed ? "1" : "0")
            e(10, "0"); e(20, "0"); e(30, "0")
            for p in pts { e(0, "VERTEX"); e(8, layer); e(10, n(p.0)); e(20, n(p.1)); e(30, "0"); ext(p.0, p.1) }
            e(0, "SEQEND"); e(8, layer)
        }
        func arc(_ cx: Double, _ cy: Double, _ r: Double, _ a0: Double, _ a1: Double, _ layer: String) {
            e(0, "ARC"); e(8, layer); e(10, n(cx)); e(20, n(cy)); e(30, "0"); e(40, n(r))
            e(50, String(format: "%.2f", a0)); e(51, String(format: "%.2f", a1))
        }
        func text(_ x: Double, _ y: Double, _ h: Double, _ s: String, _ layer: String, align: Int = 1, rot: Double = 0) {
            // align 1 = center (72), 수직 중앙(73=2) — R12는 정렬 시 11/21이 정렬점
            e(0, "TEXT"); e(8, layer); e(10, n(x)); e(20, n(y)); e(30, "0"); e(40, n(h)); e(1, s)
            if rot != 0 { e(50, String(format: "%.2f", rot)) }
            e(72, "\(align)"); e(11, n(x)); e(21, n(y)); e(31, "0"); e(73, "2")
        }

        var offsetX = 0.0
        for room in rooms {
            let p = room.plan
            guard let b = p.bounds else { continue }
            // 이 방의 좌표 변환: 평면 z(아래로 증가)를 CAD y(위로 증가)로 뒤집고 방 원점을 (offsetX, 0)에.
            func X(_ x: Double) -> Double { offsetX + (x - Double(b.minX)) }
            func Y(_ z: Double) -> Double { (Double(b.maxY) - z) }

            // 1) 외곽 벽 — 내측 폴리곤 + 200mm 바깥 오프셋 폴리곤 (이중선)
            if let bd = p.boundary, bd.count >= 3 {
                let inner = bd.map { (X($0[0]), Y($0[1])) }
                poly(inner, "A-WALL", closed: true)
                poly(offsetPolygon(inner, by: wallT), "A-WALL", closed: true)
                // 실명 + 면적 + 내측 치수
                let cx = inner.map { $0.0 }.reduce(0, +) / Double(inner.count)
                let cy = inner.map { $0.1 }.reduce(0, +) / Double(inner.count)
                text(cx, cy + 0.18, 0.18, room.name, "A-ANNO-TEXT")
                text(cx, cy - 0.10, 0.11, String(format: "%.2f m2 (%.1fP)", room.metrics.areaM2, PlanUnits.pyeong(room.metrics.areaM2)), "A-AREA")
                text(cx, cy - 0.30, 0.10, "\(PlanUnits.mm(room.metrics.widthM)) x \(PlanUnits.mm(room.metrics.depthM))  CH \(PlanUnits.mm(room.metrics.ceilingM))", "A-AREA")
            }
            // 2) 내부 벽선
            for w in p.xw ?? [] { if let x = w.pos { for s in w.segs ?? [] where s.count >= 2 { line(X(x), Y(s[0]), X(x), Y(s[1]), "A-WALL") } } }
            for w in p.zw ?? [] { if let z = w.pos { for s in w.segs ?? [] where s.count >= 2 { line(X(s[0]), Y(z), X(s[1]), Y(z), "A-WALL") } } }

            // 3) 개구부: 문 = 문짝 + 90° 호 / 창 = 벽 두께 안 3선
            for op in p.allOpenings {
                guard let dir = op.wall_dir, let wp = op.wall_pos, let span = op.span, span.count >= 2 else { continue }
                let lo = min(span[0], span[1]), hi = max(span[0], span[1])
                let width = hi - lo
                if op.type == "window" {
                    for off in [-wallT / 2, 0, wallT / 2] {
                        if dir == "x" { line(X(wp + off), Y(lo), X(wp + off), Y(hi), "A-GLAZ") }
                        else { line(X(lo), Y(wp + off), X(hi), Y(wp + off), "A-GLAZ") }
                    }
                } else {
                    // 힌지 = lo 쪽 끝, 문짝은 벽에 수직(방 안쪽 방향은 미상 → +방향)
                    if dir == "x" {
                        let hx = X(wp), hy = Y(lo)
                        line(hx, hy, hx + width, hy, "A-DOOR")
                        arc(hx, hy, width, 270, 360, "A-DOOR")
                    } else {
                        let hx = X(lo), hy = Y(wp)
                        line(hx, hy, hx, hy + width, "A-DOOR")
                        arc(hx, hy, width, 0, 90, "A-DOOR")
                    }
                }
            }

            // 4) 가구: OBB 폴리곤 + 라벨
            for f in p.furniture ?? [] {
                let cs = f.corners
                guard cs.count >= 3 else { continue }
                poly(cs.map { (X($0[0]), Y($0[1])) }, "A-FURN", closed: true)
                let cx = cs.map { X($0[0]) }.reduce(0, +) / Double(cs.count)
                let cy = cs.map { Y($0[1]) }.reduce(0, +) / Double(cs.count)
                let label = f.category_ko ?? f.category ?? ""
                if !label.isEmpty { text(cx, cy, 0.09, label, "A-FURN") }
            }

            // 5) 치수선(전체 폭·깊이) — 연장선 + 치수선 + 45° 틱 + mm 라벨
            func dim(from a: (Double, Double), to bpt: (Double, Double), out: (Double, Double), offset: Double, label: String, rot: Double) {
                let a2 = (a.0 + out.0 * offset, a.1 + out.1 * offset)
                let b2 = (bpt.0 + out.0 * offset, bpt.1 + out.1 * offset)
                line(a.0 + out.0 * 0.05, a.1 + out.1 * 0.05, a2.0 + out.0 * 0.1, a2.1 + out.1 * 0.1, "A-ANNO-DIMS")
                line(bpt.0 + out.0 * 0.05, bpt.1 + out.1 * 0.05, b2.0 + out.0 * 0.1, b2.1 + out.1 * 0.1, "A-ANNO-DIMS")
                line(a2.0, a2.1, b2.0, b2.1, "A-ANNO-DIMS")
                let len = max(hypot(b2.0 - a2.0, b2.1 - a2.1), 1e-6)
                let u = ((b2.0 - a2.0) / len, (b2.1 - a2.1) / len)
                let t = ((u.0 + out.0) * 0.0707, (u.1 + out.1) * 0.0707)   // 45° 틱 ±70mm
                for pnt in [a2, b2] { line(pnt.0 - t.0, pnt.1 - t.1, pnt.0 + t.0, pnt.1 + t.1, "A-ANNO-DIMS") }
                text((a2.0 + b2.0) / 2 + out.0 * 0.12, (a2.1 + b2.1) / 2 + out.1 * 0.12, 0.12, label, "A-ANNO-DIMS", rot: rot)
            }
            let x0 = X(Double(b.minX)), x1 = X(Double(b.maxX))
            let yTop = Y(Double(b.minY)), yBot = Y(Double(b.maxY))
            let off = wallT + 0.6
            dim(from: (x0, yTop), to: (x1, yTop), out: (0, 1), offset: off, label: "\(PlanUnits.mm(Double(b.width)))", rot: 0)
            dim(from: (x0, yBot), to: (x0, yTop), out: (-1, 0), offset: off, label: "\(PlanUnits.mm(Double(b.height)))", rot: 90)


            offsetX += Double(b.width) + gap
        }

        // 타이틀 텍스트(도면 좌하단)
        if minX.isFinite {
            let df = DateFormatter(); df.dateFormat = "yyyy.MM.dd"
            text(minX, minY - 1.0, 0.25, "\(project.name)  \(project.company.isEmpty ? "PlanShot" : project.company)  \(df.string(from: Date()))", "A-ANNO-TEXT", align: 0)
            text(minX, minY - 1.4, 0.15, PlanSheetInfo.disclaimer.replacingOccurrences(of: "—", with: "-") + " / iPhone LiDAR / 단위 mm", "A-ANNO-TEXT", align: 0)
            ext(minX, minY - 1.6)
        } else { minX = 0; minY = 0; maxX = 1; maxY = 1 }

        // ── 파일 조립 ──
        g(0, "SECTION"); g(2, "HEADER")
        g(9, "$ACADVER"); g(1, "AC1009")
        g(9, "$DWGCODEPAGE"); g(3, "ANSI_949")
        g(9, "$INSBASE"); g(10, "0"); g(20, "0"); g(30, "0")
        g(9, "$EXTMIN"); g(10, n(minX)); g(20, n(minY)); g(30, "0")
        g(9, "$EXTMAX"); g(10, n(maxX)); g(20, n(maxY)); g(30, "0")
        g(9, "$LIMMIN"); g(10, n(minX)); g(20, n(minY))
        g(9, "$LIMMAX"); g(10, n(maxX)); g(20, n(maxY))
        g(0, "ENDSEC")

        g(0, "SECTION"); g(2, "TABLES")
        g(0, "TABLE"); g(2, "LTYPE"); g(70, "1")
        g(0, "LTYPE"); g(2, "CONTINUOUS"); g(70, "64"); g(3, "Solid line"); g(72, "65"); g(73, "0"); g(40, "0.0")
        g(0, "ENDTAB")
        let layers: [(String, Int)] = [("0", 7), ("A-WALL", 7), ("A-DOOR", 3), ("A-GLAZ", 4), ("A-FURN", 8),
                                       ("A-ANNO-DIMS", 1), ("A-ANNO-TEXT", 7), ("A-AREA", 2)]
        g(0, "TABLE"); g(2, "LAYER"); g(70, "\(layers.count)")
        for (name, color) in layers {
            g(0, "LAYER"); g(2, name); g(70, "64"); g(62, "\(color)"); g(6, "CONTINUOUS")
        }
        g(0, "ENDTAB")
        g(0, "TABLE"); g(2, "STYLE"); g(70, "1")
        g(0, "STYLE"); g(2, "STANDARD"); g(70, "0"); g(40, "0.0"); g(41, "1.0"); g(50, "0.0"); g(71, "0"); g(42, "2.5"); g(3, "txt"); g(4, "")
        g(0, "ENDTAB")
        g(0, "ENDSEC")

        g(0, "SECTION"); g(2, "BLOCKS"); g(0, "ENDSEC")
        g(0, "SECTION"); g(2, "ENTITIES")
        out.append(contentsOf: ents)
        g(0, "ENDSEC")
        g(0, "EOF")
        return out.joined(separator: "\r\n") + "\r\n"
    }

    /// 단순 폴리곤을 바깥쪽으로 d만큼 오프셋(변별 평행선의 교점). Manhattan 외곽에 충분.
    static func offsetPolygon(_ pts: [(Double, Double)], by d: Double) -> [(Double, Double)] {
        let n = pts.count
        guard n >= 3 else { return pts }
        // 방향(시계/반시계) → 바깥 법선 부호
        var area2 = 0.0
        for i in 0..<n { let a = pts[i], b = pts[(i + 1) % n]; area2 += a.0 * b.1 - b.0 * a.1 }
        let sign: Double = area2 > 0 ? -1 : 1   // CCW면 왼쪽이 안쪽 → 바깥은 오른쪽(-법선)
        func offsetEdge(_ i: Int) -> ((Double, Double), (Double, Double)) {
            let a = pts[i], b = pts[(i + 1) % n]
            let dx = b.0 - a.0, dy = b.1 - a.1
            let len = max(hypot(dx, dy), 1e-9)
            let nx = -dy / len * sign, ny = dx / len * sign
            return ((a.0 + nx * d, a.1 + ny * d), (b.0 + nx * d, b.1 + ny * d))
        }
        var out: [(Double, Double)] = []
        for i in 0..<n {
            let (p1, p2) = offsetEdge((i + n - 1) % n)
            let (p3, p4) = offsetEdge(i)
            // 두 직선 교점
            let d1 = (p2.0 - p1.0, p2.1 - p1.1), d2 = (p4.0 - p3.0, p4.1 - p3.1)
            let den = d1.0 * d2.1 - d1.1 * d2.0
            if abs(den) < 1e-9 { out.append(p3); continue }
            let t = ((p3.0 - p1.0) * d2.1 - (p3.1 - p1.1) * d2.0) / den
            out.append((p1.0 + d1.0 * t, p1.1 + d1.1 * t))
        }
        return out
    }
}
