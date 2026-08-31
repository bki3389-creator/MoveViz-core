//  LayoutEditorView.swift
//  PlanShot — 탑뷰 레이아웃 편집기: 실측 평면 위에 가구를 놓고 끌어서 배치한다.
//
//  "위에서 보는 도면으로 인테리어·레이아웃 확인" — 스캔에서 인식된 가구(RoomPlan 16종)로 시작하고,
//  표준 치수 카탈로그(침대Q 1500×2000, 3인 소파 2000×900, 4인 식탁 1200×800 …)에서 추가.
//  이동(드래그) · 90° 회전 · 삭제 · 치수 수정 · 벽 밖/겹침 경고 · 방별 배치안 저장(PlanRoomRef.layout).
//  저장된 배치안은 방 상세·PDF·DXF의 가구로 그대로 쓰인다(RoomPlanLoader가 합성).

import SwiftUI

// MARK: - 모델

struct LayoutItem: Codable, Identifiable, Equatable {
    var id: String = UUID().uuidString
    var category: String            // 영문 심볼 키 (bed / sofa / table / cabinet / refrigerator …)
    var nameKo: String
    var cx: Double                  // 중심 (평면 좌표 m, XZ)
    var cz: Double
    var w: Double                   // 폭(m, 로컬 X)
    var d: Double                   // 깊이(m, 로컬 Z)
    var yawDeg: Double = 0
    var source: String = "catalog"  // scan | catalog

    var corners: [[Double]] {
        let r = yawDeg * .pi / 180, ca = cos(r), sa = sin(r)
        let hw = w / 2, hd = d / 2
        return [(-hw, -hd), (hw, -hd), (hw, hd), (-hw, hd)].map {
            [cx + $0.0 * ca - $0.1 * sa, cz + $0.0 * sa + $0.1 * ca]
        }
    }
    func contains(_ p: (x: Double, z: Double)) -> Bool {
        let r = -yawDeg * .pi / 180, ca = cos(r), sa = sin(r)
        let dx = p.x - cx, dz = p.z - cz
        let lx = dx * ca - dz * sa, lz = dx * sa + dz * ca
        return abs(lx) <= w / 2 + 0.03 && abs(lz) <= d / 2 + 0.03
    }
    func toPlanFurniture() -> PlanFurniture {
        PlanFurniture(obb: corners, polygon: nil, category: category, category_ko: nameKo,
                      yaw_deg: yawDeg, score: nil)
    }

    /// 스캔 인식 가구(PlanData.furniture) → 편집 항목.
    static func fromScan(_ plan: PlanData) -> [LayoutItem] {
        (plan.furniture ?? []).compactMap { f in
            let cs = f.corners
            guard cs.count >= 4 else { return nil }
            let w = hypot(cs[1][0] - cs[0][0], cs[1][1] - cs[0][1])
            let d = hypot(cs[3][0] - cs[0][0], cs[3][1] - cs[0][1])
            let cx = cs.map { $0[0] }.reduce(0, +) / 4, cz = cs.map { $0[1] }.reduce(0, +) / 4
            let yaw = f.yaw_deg ?? (atan2(cs[1][1] - cs[0][1], cs[1][0] - cs[0][0]) * 180 / .pi)
            return LayoutItem(category: f.category ?? "cabinet", nameKo: f.category_ko ?? f.category ?? "가구",
                              cx: cx, cz: cz, w: max(0.2, w), d: max(0.2, d), yawDeg: yaw, source: "scan")
        }
    }
}

/// 표준 치수 카탈로그 (mm) — 국내 가구 일반 규격.
enum FurnitureCatalog {
    struct Entry: Identifiable { let id = UUID(); let group: String; let name: String; let category: String; let w: Double; let d: Double }
    static let entries: [Entry] = [
        Entry(group: "침실", name: "침대 SS", category: "bed", w: 1.10, d: 2.00),
        Entry(group: "침실", name: "침대 Q", category: "bed", w: 1.50, d: 2.00),
        Entry(group: "침실", name: "침대 K", category: "bed", w: 1.60, d: 2.00),
        Entry(group: "침실", name: "옷장 1200", category: "cabinet", w: 1.20, d: 0.60),
        Entry(group: "침실", name: "붙박이장 2400", category: "cabinet", w: 2.40, d: 0.60),
        Entry(group: "침실", name: "화장대", category: "cabinet", w: 1.00, d: 0.45),
        Entry(group: "침실", name: "협탁", category: "cabinet", w: 0.45, d: 0.40),
        Entry(group: "거실", name: "소파 2인", category: "sofa", w: 1.50, d: 0.90),
        Entry(group: "거실", name: "소파 3인", category: "sofa", w: 2.00, d: 0.90),
        Entry(group: "거실", name: "소파 4인(카우치)", category: "sofa", w: 2.60, d: 1.60),
        Entry(group: "거실", name: "TV장 1800", category: "cabinet", w: 1.80, d: 0.40),
        Entry(group: "거실", name: "TV 65인치", category: "tv", w: 1.45, d: 0.06),
        Entry(group: "거실", name: "거실 테이블", category: "table", w: 1.00, d: 0.50),
        Entry(group: "거실", name: "책장 800", category: "cabinet", w: 0.80, d: 0.30),
        Entry(group: "주방", name: "식탁 4인", category: "table", w: 1.20, d: 0.80),
        Entry(group: "주방", name: "식탁 6인", category: "table", w: 1.80, d: 0.90),
        Entry(group: "주방", name: "식탁 의자", category: "chair", w: 0.45, d: 0.50),
        Entry(group: "주방", name: "냉장고 900", category: "refrigerator", w: 0.90, d: 0.80),
        Entry(group: "주방", name: "김치냉장고", category: "refrigerator", w: 0.80, d: 0.75),
        Entry(group: "주방", name: "아일랜드 1500", category: "cabinet", w: 1.50, d: 0.80),
        Entry(group: "서재", name: "책상 1200", category: "table", w: 1.20, d: 0.60),
        Entry(group: "서재", name: "책상 1600", category: "table", w: 1.60, d: 0.70),
        Entry(group: "서재", name: "사무 의자", category: "chair", w: 0.60, d: 0.60),
        Entry(group: "세탁/욕실", name: "세탁기", category: "appliance", w: 0.60, d: 0.65),
        Entry(group: "세탁/욕실", name: "건조기", category: "appliance", w: 0.60, d: 0.65),
        Entry(group: "세탁/욕실", name: "변기", category: "toilet", w: 0.40, d: 0.70),
        Entry(group: "세탁/욕실", name: "세면대", category: "sink", w: 0.60, d: 0.45),
        Entry(group: "세탁/욕실", name: "욕조 1500", category: "bathtub", w: 1.50, d: 0.75),
        Entry(group: "기타", name: "사용자 박스 1000×1000", category: "cabinet", w: 1.00, d: 1.00),
    ]
    static var groups: [String] { var o: [String] = []; for e in entries where !o.contains(e.group) { o.append(e.group) }; return o }
}

// MARK: - 평면 ↔ 화면 변환 (FloorPlanView 의 fit 수식과 동일해야 터치가 맞는다)

struct PlanTransform {
    let s: CGFloat, ox: CGFloat, oy: CGFloat
    init?(plan: PlanData, size: CGSize) {
        guard let b = plan.bounds else { return nil }
        let margin: CGFloat = 52
        s = min((size.width - margin * 2) / b.width, (size.height - margin * 2) / b.height)
        ox = (size.width - b.width * s) / 2 - b.minX * s
        oy = (size.height - b.height * s) / 2 - b.minY * s
    }
    func toScreen(_ x: Double, _ z: Double) -> CGPoint { CGPoint(x: CGFloat(x) * s + ox, y: CGFloat(z) * s + oy) }
    func toPlan(_ p: CGPoint) -> (x: Double, z: Double) { (Double((p.x - ox) / s), Double((p.y - oy) / s)) }
}

extension PlanData {
    /// 가구만 바꾼 사본 (배치안 합성용).
    func replacingFurniture(_ f: [PlanFurniture]) -> PlanData {
        PlanData(source: source, floor_y: floor_y, ceil_y: ceil_y, boundary: boundary, xw: xw, zw: zw,
                 openings: openings, interior_openings: interior_openings, doors: doors, rooms: rooms,
                 furniture: f, furniture_vision: furniture_vision, furniture_geometry: furniture_geometry)
    }
}

// MARK: - 편집기

struct LayoutEditorView: View {
    let projectID: String
    let room: PlanRoomRef
    let basePlan: PlanData                  // 보정 적용 스캔 평면
    let onSave: (PlanRoomRef) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var items: [LayoutItem]
    @State private var selected: String?
    @State private var zoom: CGFloat = 1
    @State private var pan: CGSize = .zero
    @GestureState private var pinch: CGFloat = 1
    @State private var dragItem: LayoutItem?        // 드래그 시작 시 스냅샷
    @State private var dragPan: CGSize?             // 빈 곳 드래그 = 팬
    @State private var didHitTest = false
    @State private var showPalette = false
    @State private var showSize = false
    @State private var warnings: [String: String] = [:]

    init(projectID: String, room: PlanRoomRef, basePlan: PlanData, onSave: @escaping (PlanRoomRef) -> Void) {
        self.projectID = projectID; self.room = room; self.basePlan = basePlan; self.onSave = onSave
        _items = State(initialValue: room.layout ?? LayoutItem.fromScan(basePlan))
    }

    private var composed: PlanData { basePlan.replacingFurniture(items.map { $0.toPlanFurniture() }) }
    private var selectedItem: LayoutItem? { items.first { $0.id == selected } }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                GeometryReader { geo in
                    let size = geo.size
                    let tf = PlanTransform(plan: basePlan, size: size)
                    ZStack {
                        Color(.systemBackground)
                        FloorPlanView(plan: composed, sheet: PlanSheetInfo(roomName: room.name, showTitleBlock: false),
                                      interactive: false)
                        Canvas { ctx, _ in
                            guard let tf else { return }
                            for it in items {
                                let cs = it.corners
                                var p = Path()
                                p.move(to: tf.toScreen(cs[0][0], cs[0][1]))
                                for c in cs.dropFirst() { p.addLine(to: tf.toScreen(c[0], c[1])) }
                                p.closeSubpath()
                                if let w = warnings[it.id] {
                                    ctx.fill(p, with: .color(.red.opacity(0.18)))
                                    ctx.draw(Text(w).font(.system(size: 8, weight: .bold)).foregroundColor(.red),
                                             at: tf.toScreen(it.cx, it.cz - it.d / 2 - 0.12))
                                }
                                if it.id == selected {
                                    ctx.stroke(p, with: .color(PSTheme.accent), style: StrokeStyle(lineWidth: 2.5, dash: [6, 3]))
                                    // 치수 라벨
                                    ctx.draw(Text("\(PlanUnits.mm(it.w)) × \(PlanUnits.mm(it.d))")
                                                .font(.system(size: 9, weight: .semibold).monospacedDigit())
                                                .foregroundColor(PSTheme.accent),
                                             at: tf.toScreen(it.cx, it.cz + it.d / 2 + 0.16))
                                }
                            }
                        }
                        .allowsHitTesting(false)
                    }
                    .frame(width: size.width, height: size.height)
                    .contentShape(Rectangle())
                    .gesture(dragGesture(tf))
                    .scaleEffect(zoom * pinch)
                    .offset(pan)
                    .clipped()
                    .simultaneousGesture(
                        MagnificationGesture()
                            .updating($pinch) { v, st, _ in st = v }
                            .onEnded { zoom = max(0.6, min(5, zoom * $0)) }
                    )
                    .onTapGesture(count: 2) { withAnimation { zoom = 1; pan = .zero } }
                }
                .background(Color(.systemBackground))

                toolbar
            }
            .background(PSTheme.canvas.ignoresSafeArea())
            .navigationTitle("배치안 · \(room.name)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("취소") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("저장") {
                        var r = room; r.layout = items
                        onSave(r); dismiss()
                    }.fontWeight(.semibold)
                }
            }
            .sheet(isPresented: $showPalette) { PaletteSheet { add($0) } }
            .sheet(isPresented: $showSize) {
                if let it = selectedItem {
                    SizeSheet(item: it) { updated in
                        if let i = items.firstIndex(where: { $0.id == updated.id }) { items[i] = updated; validate() }
                    }
                }
            }
            .onAppear { validate() }
        }
    }

    // MARK: 제스처

    private func dragGesture(_ tf: PlanTransform?) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { v in
                guard let tf else { return }
                if !didHitTest {
                    didHitTest = true
                    let p = tf.toPlan(v.startLocation)
                    if let hit = items.last(where: { $0.contains(p) }) {
                        selected = hit.id; dragItem = hit; dragPan = nil
                    } else {
                        dragItem = nil; dragPan = pan
                        if v.translation == .zero { selected = nil }
                    }
                }
                if let d = dragItem, let i = items.firstIndex(where: { $0.id == d.id }) {
                    let z = Double(zoom * pinch)
                    items[i].cx = d.cx + Double(v.translation.width) / Double(tf.s) / z
                    items[i].cz = d.cz + Double(v.translation.height) / Double(tf.s) / z
                } else if let p0 = dragPan {
                    pan = CGSize(width: p0.width + v.translation.width, height: p0.height + v.translation.height)
                }
            }
            .onEnded { _ in
                if let d = dragItem, let i = items.firstIndex(where: { $0.id == d.id }) {
                    items[i].cx = (items[i].cx * 100).rounded() / 100      // 10mm 스냅
                    items[i].cz = (items[i].cz * 100).rounded() / 100
                }
                dragItem = nil; dragPan = nil; didHitTest = false
                validate()
            }
    }

    // MARK: 툴바

    private var toolbar: some View {
        VStack(spacing: 8) {
            if let it = selectedItem {
                HStack(spacing: 8) {
                    PSBadge(text: it.source == "scan" ? "스캔 인식" : "카탈로그", color: it.source == "scan" ? PSTheme.ok : PSTheme.accent)
                    Text(it.nameKo).font(.subheadline.weight(.semibold))
                    Text("\(PlanUnits.mm(it.w)) × \(PlanUnits.mm(it.d)) mm").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    if let w = warnings[it.id] { Text(w).font(.caption2.bold()).foregroundStyle(.red) }
                    Spacer()
                }
                .padding(.horizontal, 14)
            } else {
                Text("가구를 탭해 선택 · 드래그로 이동 · 빈 곳 드래그로 화면 이동 · 핀치 확대")
                    .font(.caption2).foregroundStyle(.secondary).padding(.horizontal, 14)
            }
            HStack(spacing: 8) {
                tool("가구 추가", "plus.square.on.square") { showPalette = true }
                tool("회전 90°", "rotate.right", enabled: selected != nil) { rotate() }
                tool("치수", "arrow.left.and.right.square", enabled: selected != nil) { showSize = true }
                tool("삭제", "trash", enabled: selected != nil, tint: .red) { remove() }
                tool("스캔대로", "arrow.counterclockwise") { items = LayoutItem.fromScan(basePlan); selected = nil; validate() }
            }
            .padding(.horizontal, 10)
        }
        .padding(.vertical, 10)
        .background(PSTheme.card)
    }

    private func tool(_ title: String, _ icon: String, enabled: Bool = true, tint: Color = PSTheme.accent,
                      action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 4) {
                Image(systemName: icon).font(.system(size: 18, weight: .medium))
                Text(title).font(.caption2)
            }
            .frame(maxWidth: .infinity).padding(.vertical, 8)
            .background(tint.opacity(enabled ? 0.14 : 0.05), in: RoundedRectangle(cornerRadius: 10))
            .foregroundStyle(enabled ? tint : .secondary)
        }
        .disabled(!enabled)
    }

    // MARK: 편집 동작

    private func add(_ e: FurnitureCatalog.Entry) {
        guard let b = basePlan.bounds else { return }
        let item = LayoutItem(category: e.category, nameKo: e.name,
                              cx: Double(b.midX), cz: Double(b.midY), w: e.w, d: e.d, yawDeg: 0, source: "catalog")
        items.append(item); selected = item.id; validate()
    }
    private func rotate() {
        guard let i = items.firstIndex(where: { $0.id == selected }) else { return }
        items[i].yawDeg = (items[i].yawDeg + 90).truncatingRemainder(dividingBy: 360)
        validate()
    }
    private func remove() {
        items.removeAll { $0.id == selected }; selected = nil; validate()
    }

    /// 벽 밖(외곽 폴리곤 바깥 코너) / 다른 가구와 겹침 경고.
    private func validate() {
        var w: [String: String] = [:]
        let boundary = basePlan.boundary ?? []
        for it in items {
            if boundary.count >= 3, it.corners.contains(where: { !Self.inside($0, boundary) }) {
                w[it.id] = "벽 밖"
                continue
            }
            for other in items where other.id != it.id {
                if Self.overlap(it, other) { w[it.id] = "겹침"; break }
            }
        }
        warnings = w
    }

    private static func inside(_ p: [Double], _ poly: [[Double]]) -> Bool {
        var c = false
        var j = poly.count - 1
        for i in 0..<poly.count {
            let a = poly[i], b = poly[j]
            if (a[1] > p[1]) != (b[1] > p[1]),
               p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1] + 1e-12) + a[0] { c.toggle() }
            j = i
        }
        return c
    }
    /// OBB 겹침 — 한쪽의 코너/중심이 다른 쪽 안에 들어오면 겹침(경고 용도로 충분).
    private static func overlap(_ a: LayoutItem, _ b: LayoutItem) -> Bool {
        let aPts = a.corners + [[a.cx, a.cz]], bPts = b.corners + [[b.cx, b.cz]]
        if aPts.contains(where: { b.contains((x: $0[0], z: $0[1])) }) { return true }
        if bPts.contains(where: { a.contains((x: $0[0], z: $0[1])) }) { return true }
        return false
    }
}

// MARK: - 팔레트 / 치수 시트

private struct PaletteSheet: View {
    @Environment(\.dismiss) private var dismiss
    let onPick: (FurnitureCatalog.Entry) -> Void
    var body: some View {
        NavigationStack {
            List {
                ForEach(FurnitureCatalog.groups, id: \.self) { g in
                    Section(g) {
                        ForEach(FurnitureCatalog.entries.filter { $0.group == g }) { e in
                            Button { onPick(e); dismiss() } label: {
                                HStack {
                                    Image(systemName: icon(e.category)).foregroundStyle(PSTheme.accent).frame(width: 26)
                                    Text(e.name)
                                    Spacer()
                                    Text("\(PlanUnits.mm(e.w)) × \(PlanUnits.mm(e.d))").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("가구 추가")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("닫기") { dismiss() } } }
        }
    }
    private func icon(_ c: String) -> String {
        switch c {
        case "bed": return "bed.double.fill"
        case "sofa": return "sofa.fill"
        case "table": return "table.furniture.fill"
        case "chair": return "chair.fill"
        case "refrigerator": return "refrigerator.fill"
        case "tv": return "tv.fill"
        case "toilet": return "toilet.fill"
        case "sink": return "sink.fill"
        case "bathtub": return "bathtub.fill"
        case "appliance": return "washer.fill"
        default: return "cabinet.fill"
        }
    }
}

private struct SizeSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State var item: LayoutItem
    let onSave: (LayoutItem) -> Void
    @State private var wText = ""
    @State private var dText = ""
    @State private var name = ""
    var body: some View {
        NavigationStack {
            Form {
                Section("이름") { TextField("이름", text: $name) }
                Section("치수 (mm)") {
                    HStack { Text("폭"); Spacer(); TextField("mm", text: $wText).keyboardType(.numberPad).multilineTextAlignment(.trailing).frame(width: 110) }
                    HStack { Text("깊이"); Spacer(); TextField("mm", text: $dText).keyboardType(.numberPad).multilineTextAlignment(.trailing).frame(width: 110) }
                }
            }
            .navigationTitle("가구 치수")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("취소") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("적용") {
                        var it = item
                        if let w = Double(wText.filter { $0.isNumber }), w >= 100, w <= 6000 { it.w = w / 1000 }
                        if let d = Double(dText.filter { $0.isNumber }), d >= 50, d <= 6000 { it.d = d / 1000 }
                        if !name.trimmingCharacters(in: .whitespaces).isEmpty { it.nameKo = name }
                        onSave(it); dismiss()
                    }
                }
            }
            .onAppear { wText = "\(PlanUnits.mm(item.w))"; dText = "\(PlanUnits.mm(item.d))"; name = item.nameKo }
        }
    }
}
