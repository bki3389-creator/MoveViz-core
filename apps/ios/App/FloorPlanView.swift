//  FloorPlanView.swift
//  MoveViz — plan.json 벡터 평면도의 네이티브 렌더러 (건축 도면 스타일).
//
//  건축 평면 표기: 두께 있는 이중선 벽 밴드, 외곽 치수선(연장선+45°틱+mm 표기),
//  문(스윙 호+문짝) / 창(3선) 심볼, 방 채움, 가구 회전 OBB+라벨, 면적, 축척바.
//  핀치 줌 · 팬 · 더블탭 리셋.

import SwiftUI

struct FloorPlanView: View {
    let plan: PlanData

    @State private var zoom: CGFloat = 1
    @State private var pan: CGSize = .zero
    @GestureState private var pinch: CGFloat = 1
    @GestureState private var drag: CGSize = .zero

    private let wallT = 0.15      // 외곽 벽 두께(m)
    private let innerT = 0.10     // 내부 벽 두께(m)

    /// 카테고리 문자열(영/동의어) → 심볼 키. 매핑 없으면 "" = 외곽선만.
    private func canonicalSymbol(_ cat: String?) -> String {
        switch (cat ?? "").lowercased() {
        case "bed": return "bed"
        case "sofa", "couch": return "sofa"
        case "chair", "stool", "armchair": return "chair"
        case "toilet": return "toilet"
        case "sink", "washbasin", "basin": return "sink"
        case "bathtub", "tub", "shower": return "bathtub"
        case "refrigerator", "fridge": return "fridge"
        case "tv", "television", "monitor": return "tv"
        case "cabinet", "storage", "wardrobe", "shelf", "rack",
             "bookshelf", "dresser", "counter": return "cabinet"
        case "appliance", "washer", "washerdryer", "oven", "stove",
             "dishwasher": return "appliance"
        default: return ""
        }
    }

    var body: some View {
        GeometryReader { _ in
            let effZoom = zoom * pinch
            let effPan = CGSize(width: pan.width + drag.width,
                                height: pan.height + drag.height)
            Canvas { ctx, size in
                guard let b = plan.bounds else { return }
                let margin: CGFloat = 52          // 치수선 자리 확보
                let s = min((size.width - margin * 2) / b.width,
                            (size.height - margin * 2) / b.height) * effZoom
                let ox = (size.width - b.width * s) / 2 - b.minX * s + effPan.width
                let oy = (size.height - b.height * s) / 2 - b.minY * s + effPan.height
                func T(_ x: Double, _ z: Double) -> CGPoint {
                    CGPoint(x: CGFloat(x) * s + ox, y: CGFloat(z) * s + oy)
                }
                func path(of pts: [[Double]], close: Bool = true) -> Path {
                    var p = Path()
                    guard let f = pts.first, f.count >= 2 else { return p }
                    p.move(to: T(f[0], f[1]))
                    for q in pts.dropFirst() where q.count >= 2 { p.addLine(to: T(q[0], q[1])) }
                    if close { p.closeSubpath() }
                    return p
                }
                let bg = Color(.systemBackground)
                let ink = Color.primary
                let fmt = NumberFormatter()
                fmt.numberStyle = .decimal            // 1,234 (건축 관례: mm)
                func mm(_ meters: Double) -> String {
                    fmt.string(from: NSNumber(value: Int((meters * 1000).rounded()))) ?? ""
                }

                // ── 벽 밴드: 진한 외곽선 2줄 + 밝은 코어(건축 이중선) ──
                func wallBand(_ p: Path, thicknessM: Double) {
                    let t = max(4, CGFloat(thicknessM) * s)
                    ctx.stroke(p, with: .color(ink),
                               style: StrokeStyle(lineWidth: t, lineCap: .square, lineJoin: .miter))
                    ctx.stroke(p, with: .color(Color(.systemGray5)),
                               style: StrokeStyle(lineWidth: max(1, t - 3),
                                                  lineCap: .square, lineJoin: .miter))
                }

                // 1) 방 채움 (아주 옅게 — 벽이 주인공)
                for room in plan.rooms ?? [] {
                    guard let poly = room.polygon, poly.count >= 3 else { continue }
                    ctx.fill(path(of: poly), with: .color(Color(.systemFill).opacity(0.35)))
                }

                // 2) 외곽 경계 벽 밴드
                if let boundary = plan.boundary, boundary.count >= 2 {
                    wallBand(path(of: boundary), thicknessM: wallT)
                }

                // 3) 내부 벽 밴드 (xw: x=pos 세로벽 / zw: z=pos 가로벽)
                for w in plan.xw ?? [] {
                    guard let x = w.pos else { continue }
                    for seg in w.segs ?? [] where seg.count >= 2 {
                        var p = Path(); p.move(to: T(x, seg[0])); p.addLine(to: T(x, seg[1]))
                        wallBand(p, thicknessM: innerT)
                    }
                }
                for w in plan.zw ?? [] {
                    guard let z = w.pos else { continue }
                    for seg in w.segs ?? [] where seg.count >= 2 {
                        var p = Path(); p.move(to: T(seg[0], z)); p.addLine(to: T(seg[1], z))
                        wallBand(p, thicknessM: innerT)
                    }
                }

                // 4) 개구부 — 건축 표기: 문 = 벽 갭+문짝+스윙 호 / 창 = 벽 갭+3선
                for op in plan.allOpenings {
                    guard let dir = op.wall_dir, let wp = op.wall_pos,
                          let span = op.span, span.count >= 2 else { continue }
                    let (lo, hi) = (min(span[0], span[1]), max(span[0], span[1]))
                    let a = dir == "x" ? T(wp, lo) : T(lo, wp)
                    let cpt = dir == "x" ? T(wp, hi) : T(hi, wp)
                    // 벽 갭
                    var gap = Path(); gap.move(to: a); gap.addLine(to: cpt)
                    ctx.stroke(gap, with: .color(bg),
                               style: StrokeStyle(lineWidth: max(6, CGFloat(wallT) * s + 2)))
                    if op.type == "window" {
                        // 창: 벽 두께 안에 평행 3선 (KS 표기)
                        for off in [-wallT / 2, 0, wallT / 2] {
                            var wl = Path()
                            if dir == "x" {
                                wl.move(to: T(wp + off, lo)); wl.addLine(to: T(wp + off, hi))
                            } else {
                                wl.move(to: T(lo, wp + off)); wl.addLine(to: T(hi, wp + off))
                            }
                            ctx.stroke(wl, with: .color(ink.opacity(0.9)),
                                       style: StrokeStyle(lineWidth: 1))
                        }
                        // 잼(개구부 양끝 마감선)
                        for pt in [a, cpt] {
                            var jam = Path()
                            let half = CGFloat(wallT / 2) * s
                            if dir == "x" {
                                jam.move(to: CGPoint(x: pt.x - half, y: pt.y))
                                jam.addLine(to: CGPoint(x: pt.x + half, y: pt.y))
                            } else {
                                jam.move(to: CGPoint(x: pt.x, y: pt.y - half))
                                jam.addLine(to: CGPoint(x: pt.x, y: pt.y + half))
                            }
                            ctx.stroke(jam, with: .color(ink), style: StrokeStyle(lineWidth: 1.4))
                        }
                    } else {  // 문: 힌지에서 문짝(직선) + 90° 스윙 호(점선)
                        let r = hypot(cpt.x - a.x, cpt.y - a.y)
                        let doorAng = Angle(radians: atan2(cpt.y - a.y, cpt.x - a.x))
                        let leafEnd = CGPoint(
                            x: a.x + r * CGFloat(cos(doorAng.radians + .pi / 2)),
                            y: a.y + r * CGFloat(sin(doorAng.radians + .pi / 2)))
                        var leaf = Path(); leaf.move(to: a); leaf.addLine(to: leafEnd)
                        ctx.stroke(leaf, with: .color(ink), style: StrokeStyle(lineWidth: 1.6))
                        var arc = Path()
                        arc.addArc(center: a, radius: r, startAngle: doorAng,
                                   endAngle: doorAng + .degrees(90), clockwise: false)
                        ctx.stroke(arc, with: .color(ink.opacity(0.75)),
                                   style: StrokeStyle(lineWidth: 1, dash: [3, 2.5]))
                    }
                }

                // 5) 가구: 건축 도면식 카테고리 심볼 (회전 OBB 로컬좌표에 작도)
                for f in plan.furniture ?? [] {
                    let cs = f.corners
                    guard cs.count >= 3 else { continue }
                    let cx = cs.map { $0[0] }.reduce(0, +) / Double(cs.count)
                    let cz = cs.map { $0[1] }.reduce(0, +) / Double(cs.count)

                    // 로컬 프레임: a∈[-1,1] = 폭 방향, b∈[-1,1] = 깊이 방향 (회전 반영)
                    var eu = (x: 0.5, z: 0.0), ev = (x: 0.0, z: 0.5)
                    if cs.count >= 4 {
                        eu = (x: (cs[1][0] - cs[0][0]) / 2, z: (cs[1][1] - cs[0][1]) / 2)
                        ev = (x: (cs[3][0] - cs[0][0]) / 2, z: (cs[3][1] - cs[0][1]) / 2)
                    }
                    let wM = 2 * hypot(eu.x, eu.z), dM = 2 * hypot(ev.x, ev.z)
                    func P(_ a: Double, _ b: Double) -> CGPoint {
                        T(cx + a * eu.x + b * ev.x, cz + a * eu.z + b * ev.z)
                    }
                    func rect(_ a0: Double, _ b0: Double, _ a1: Double, _ b1: Double) -> Path {
                        var p = Path()
                        p.move(to: P(a0, b0)); p.addLine(to: P(a1, b0))
                        p.addLine(to: P(a1, b1)); p.addLine(to: P(a0, b1))
                        p.closeSubpath(); return p
                    }
                    func line(_ a0: Double, _ b0: Double, _ a1: Double, _ b1: Double) -> Path {
                        var p = Path(); p.move(to: P(a0, b0)); p.addLine(to: P(a1, b1)); return p
                    }
                    func ellipse(_ ca: Double, _ cb: Double, _ ra: Double, _ rb: Double) -> Path {
                        var p = Path()
                        for i in 0...20 {
                            let t = Double(i) / 20 * 2 * Double.pi
                            let pt = P(ca + ra * cos(t), cb + rb * sin(t))
                            if i == 0 { p.move(to: pt) } else { p.addLine(to: pt) }
                        }
                        p.closeSubpath(); return p
                    }

                    let outline = rect(-1, -1, 1, 1)
                    ctx.fill(outline, with: .color(.teal.opacity(0.08)))
                    ctx.stroke(outline, with: .color(ink.opacity(0.85)),
                               style: StrokeStyle(lineWidth: 1.0))

                    // 화면상 크기가 충분할 때만 내부 심볼 (작으면 박스만)
                    let pxSize = min(wM, dM) * s
                    if pxSize > 12 {
                        let thin = StrokeStyle(lineWidth: 0.8)
                        let sym = ink.opacity(0.7)
                        switch canonicalSymbol(f.category) {
                        case "bed":
                            // 베개(머리쪽 b=-1) + 이불 접힘선
                            if wM > 1.15 {
                                ctx.stroke(rect(-0.85, -0.85, -0.08, -0.5), with: .color(sym), style: thin)
                                ctx.stroke(rect(0.08, -0.85, 0.85, -0.5), with: .color(sym), style: thin)
                            } else {
                                ctx.stroke(rect(-0.7, -0.85, 0.7, -0.5), with: .color(sym), style: thin)
                            }
                            ctx.stroke(line(-1, -0.3, 1, -0.3), with: .color(sym), style: thin)
                            ctx.stroke(line(0.65, -0.3, 1, 0.05), with: .color(sym), style: thin)
                        case "sofa":
                            ctx.stroke(rect(-1, -1, 1, -0.55), with: .color(sym), style: thin)   // 등받이
                            ctx.stroke(rect(-1, -1, -0.76, 1), with: .color(sym), style: thin)   // 팔걸이
                            ctx.stroke(rect(0.76, -1, 1, 1), with: .color(sym), style: thin)
                            if wM > 1.4 {                                                        // 쿠션 분할
                                ctx.stroke(line(0, -0.55, 0, 1), with: .color(sym), style: thin)
                            }
                        case "chair":
                            ctx.stroke(rect(-1, -1, 1, -0.55), with: .color(sym), style: thin)   // 등받이
                            ctx.stroke(rect(-0.75, -0.45, 0.75, 0.9), with: .color(sym), style: thin)
                        case "toilet":
                            ctx.stroke(rect(-0.9, -1, 0.9, -0.4), with: .color(sym), style: thin) // 탱크
                            ctx.stroke(ellipse(0, 0.3, 0.7, 0.62), with: .color(sym), style: thin) // 보울
                        case "sink":
                            ctx.stroke(ellipse(0, 0.08, 0.68, 0.58), with: .color(sym), style: thin) // 수반
                            ctx.stroke(rect(-0.14, -1, 0.14, -0.7), with: .color(sym), style: thin)  // 수전
                        case "bathtub":
                            ctx.stroke(rect(-0.8, -0.8, 0.8, 0.82), with: .color(sym), style: thin)  // 내곽
                            ctx.stroke(ellipse(0, -0.55, 0.12, 0.1), with: .color(sym), style: thin) // 배수구
                        case "fridge":
                            ctx.stroke(line(-1, 1, 0, -0.2), with: .color(sym), style: thin)
                            ctx.stroke(line(1, 1, 0, -0.2), with: .color(sym), style: thin)
                        case "cabinet":
                            ctx.stroke(line(-1, -1, 1, 1), with: .color(sym), style: thin)  // 수납 X
                            ctx.stroke(line(-1, 1, 1, -1), with: .color(sym), style: thin)
                        case "appliance":
                            ctx.stroke(ellipse(0, 0, 0.55, 0.55), with: .color(sym), style: thin) // 드럼
                            ctx.stroke(ellipse(0, 0, 0.2, 0.2), with: .color(sym), style: thin)
                        case "tv":
                            ctx.stroke(line(-0.9, 0, 0.9, 0), with: .color(sym),
                                       style: StrokeStyle(lineWidth: 1.4))
                        default:
                            break  // 테이블/기타: 외곽선만 (도면 관례)
                        }
                    }

                    let label = f.category_ko ?? f.category ?? ""
                    if !label.isEmpty, s > 25, pxSize > 22 {
                        ctx.draw(Text(label).font(.system(size: max(8, min(11, 0.2 * s))))
                                    .foregroundColor(.teal),
                                 at: P(0, dM > 0.9 ? 0.55 : 0))
                    }
                }

                // ── 치수선(건축식): 연장선 + 치수선 + 45°틱 + mm 라벨 ──
                func dimLine(from A: CGPoint, to B: CGPoint, out: CGVector,
                             meters: Double, offset: CGFloat) {
                    let A2 = CGPoint(x: A.x + out.dx * offset, y: A.y + out.dy * offset)
                    let B2 = CGPoint(x: B.x + out.dx * offset, y: B.y + out.dy * offset)
                    var p = Path()
                    // 연장선
                    p.move(to: CGPoint(x: A.x + out.dx * 3, y: A.y + out.dy * 3))
                    p.addLine(to: CGPoint(x: A2.x + out.dx * 4, y: A2.y + out.dy * 4))
                    p.move(to: CGPoint(x: B.x + out.dx * 3, y: B.y + out.dy * 3))
                    p.addLine(to: CGPoint(x: B2.x + out.dx * 4, y: B2.y + out.dy * 4))
                    // 치수선
                    p.move(to: A2); p.addLine(to: B2)
                    ctx.stroke(p, with: .color(ink.opacity(0.65)), style: StrokeStyle(lineWidth: 0.8))
                    // 45° 틱
                    let len = max(hypot(B2.x - A2.x, B2.y - A2.y), 0.001)
                    let u = CGVector(dx: (B2.x - A2.x) / len, dy: (B2.y - A2.y) / len)
                    let tick = CGVector(dx: (u.dx + out.dx) * 0.707, dy: (u.dy + out.dy) * 0.707)
                    for P in [A2, B2] {
                        var t = Path()
                        t.move(to: CGPoint(x: P.x - tick.dx * 4, y: P.y - tick.dy * 4))
                        t.addLine(to: CGPoint(x: P.x + tick.dx * 4, y: P.y + tick.dy * 4))
                        ctx.stroke(t, with: .color(ink), style: StrokeStyle(lineWidth: 1.2))
                    }
                    // 라벨 (mm)
                    let mid = CGPoint(x: (A2.x + B2.x) / 2 + out.dx * 9,
                                      y: (A2.y + B2.y) / 2 + out.dy * 9)
                    ctx.draw(Text(mm(meters))
                                .font(.system(size: 9, weight: .medium).monospacedDigit())
                                .foregroundColor(ink),
                             at: mid)
                }

                // 전체 폭(상단)·깊이(좌측) 치수
                dimLine(from: T(b.minX, b.minY), to: T(b.maxX, b.minY),
                        out: CGVector(dx: 0, dy: -1), meters: b.width, offset: 34)
                dimLine(from: T(b.minX, b.minY), to: T(b.minX, b.maxY),
                        out: CGVector(dx: -1, dy: 0), meters: b.height, offset: 34)

                // 외곽 각 변 치수 (전체 스팬과 겹치는 변은 생략, 짧은 변도 생략)
                if let boundary = plan.boundary, boundary.count >= 3 {
                    let closed = boundary + [boundary[0]]
                    let cxm = b.midX, czm = b.midY
                    for i in 0..<(closed.count - 1) {
                        let p0 = closed[i], p1 = closed[i + 1]
                        guard p0.count >= 2, p1.count >= 2 else { continue }
                        let elen = hypot(p1[0] - p0[0], p1[1] - p0[1])
                        guard elen >= 0.45, CGFloat(elen) * s >= 34 else { continue }
                        let horizontal = abs(p1[0] - p0[0]) >= abs(p1[1] - p0[1])
                        if horizontal, elen >= b.width * 0.98 { continue }   // 전체 폭과 중복
                        if !horizontal, elen >= b.height * 0.98 { continue } // 전체 깊이와 중복
                        let mx = (p0[0] + p1[0]) / 2, mz = (p0[1] + p1[1]) / 2
                        let out = horizontal
                            ? CGVector(dx: 0, dy: mz >= czm ? 1 : -1)
                            : CGVector(dx: mx >= cxm ? 1 : -1, dy: 0)
                        dimLine(from: T(p0[0], p0[1]), to: T(p1[0], p1[1]),
                                out: out, meters: elen, offset: 15)
                    }
                }

                // 면적 + 축척바 (좌하단 고정)
                let area = (plan.rooms ?? []).compactMap { $0.area_m2 }.reduce(0, +)
                let sb = CGPoint(x: 16, y: size.height - 16)
                var bar = Path(); bar.move(to: sb); bar.addLine(to: CGPoint(x: sb.x + s, y: sb.y))
                ctx.stroke(bar, with: .color(.secondary), style: StrokeStyle(lineWidth: 2))
                ctx.draw(Text("1 m").font(.caption2).foregroundColor(.secondary),
                         at: CGPoint(x: sb.x + s / 2, y: sb.y - 9))
                if area > 0 {
                    ctx.draw(Text(String(format: "%.1f ㎡", area))
                                .font(.system(size: 12, weight: .bold))
                                .foregroundColor(ink),
                             at: CGPoint(x: sb.x + s + 44, y: sb.y - 2))
                }
            }
            .contentShape(Rectangle())
            .gesture(
                SimultaneousGesture(
                    MagnificationGesture()
                        .updating($pinch) { v, st, _ in st = v }
                        .onEnded { zoom = max(0.5, min(8, zoom * $0)) },
                    DragGesture()
                        .updating($drag) { v, st, _ in st = v.translation }
                        .onEnded { pan.width += $0.translation.width
                                   pan.height += $0.translation.height }
                )
            )
            .onTapGesture(count: 2) { withAnimation { zoom = 1; pan = .zero } }
        }
        .background(Color(.systemBackground))
    }
}
