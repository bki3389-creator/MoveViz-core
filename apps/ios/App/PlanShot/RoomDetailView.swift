//  RoomDetailView.swift
//  PlanShot — 방 상세: 도면(타이틀블록) · 실 지표 · 레이저 보정 · 3D 보기.

import SwiftUI

/// 방(PlanRoomRef) → 저장된 스캔에서 PlanData 로드. plan.json(스캔 시 귀속) 우선,
/// 없으면 RoomPlan capturedroom JSON에서 재생성(iOS 17).
enum RoomPlanLoader {
    @MainActor
    static func rawPlan(for room: PlanRoomRef) -> PlanData? {
        guard let scan = ScanStore.shared.scans.first(where: { $0.id == room.scanID }) else { return nil }
        if scan.hasPlan, let d = try? Data(contentsOf: scan.planURL),
           let p = try? JSONDecoder().decode(PlanData.self, from: d) {
            return p
        }
        if scan.hasRoomJSON {
            if #available(iOS 17.0, *) {
                return PlanData.fromCapturedRoomFile(scan.roomJSONURL)
            }
        }
        return nil
    }

    /// 보정(레이저 스케일·천장고) 적용 + 배치안(layout)이 있으면 가구를 배치안으로 교체.
    @MainActor
    static func plan(for room: PlanRoomRef) -> PlanData? {
        guard let p = rawPlan(for: room)?.applying(room.correction) else { return nil }
        if let layout = room.layout { return p.replacingFurniture(layout.map { $0.toPlanFurniture() }) }
        return p
    }
}

struct RoomDetailView: View {
    let projectID: String
    @State var room: PlanRoomRef
    @ObservedObject private var projects = ProjectStore.shared
    @State private var rawPlan: PlanData?
    @State private var showCorrection = false
    @State private var showLayout = false
    @State private var showRename = false
    @State private var modelURL: URL?
    @State private var planMode = 0          // 0 = 2D 도면, 1 = 3D

    private var project: PlanProject? { projects.project(id: projectID) }
    private var correctedPlan: PlanData? { rawPlan?.applying(room.correction) }
    private var plan: PlanData? {
        guard let p = correctedPlan else { return nil }
        if let layout = room.layout { return p.replacingFurniture(layout.map { $0.toPlanFurniture() }) }
        return p
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                if let plan {
                    let sheet = PlanSheetInfo(
                        roomName: room.name, projectName: project?.name ?? "",
                        company: project?.company ?? "", client: project?.clientName ?? "",
                        address: project?.address ?? "", date: room.createdAt,
                        ceilingM: room.correction.ceilingM,
                        corrected: room.correction.isApplied,
                        watermark: nil, showTitleBlock: true)

                    Picker("보기", selection: $planMode) {
                        Text("2D 도면").tag(0)
                        Text("3D").tag(1)
                    }
                    .pickerStyle(.segmented).padding(.horizontal)

                    Group {
                        if planMode == 0 {
                            FloorPlanView(plan: plan, sheet: sheet)
                        } else {
                            FloorPlan3DView(plan: plan)
                        }
                    }
                    .frame(height: 460)
                    .background(Color(.systemBackground))
                    .clipShape(RoundedRectangle(cornerRadius: PSTheme.radius))
                    .overlay(RoundedRectangle(cornerRadius: PSTheme.radius).stroke(.quaternary, lineWidth: 1))
                    .padding(.horizontal)
                    Text(planMode == 0 ? "핀치 확대 · 드래그 이동 · 더블탭 초기화 · 치수 mm"
                                       : "드래그 회전 · 핀치 확대")
                        .font(.caption2).foregroundStyle(.tertiary)

                    metricsGrid(PlanMetrics.metrics(of: plan, roomName: room.name,
                                                    ceilingOverride: room.correction.ceilingM))
                } else {
                    VStack(spacing: 8) {
                        Image(systemName: "exclamationmark.triangle").font(.largeTitle).foregroundStyle(.orange)
                        Text("평면도를 불러올 수 없습니다").font(.headline)
                        Text("스캔 파일(내 스캔)이 삭제되었거나 벽이 2개 미만입니다.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }.padding(.vertical, 60)
                }

                Button { showLayout = true } label: {
                    HStack {
                        Label(room.layout == nil ? "배치안 만들기 — 탑뷰 레이아웃" : "배치안 편집 (\(room.layout?.count ?? 0)개 가구)",
                              systemImage: "square.grid.3x3.topleft.filled")
                        Spacer()
                        if room.layout != nil { PSBadge(text: "배치안 적용", color: PSTheme.ok) }
                    }
                }
                .buttonStyle(PSPrimaryButton()).disabled(rawPlan == nil)
                .padding(.horizontal)

                HStack(spacing: 10) {
                    Button { showCorrection = true } label: {
                        Label(room.correction.isApplied ? "레이저 보정 수정" : "레이저 보정",
                              systemImage: "ruler").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(PSSecondaryButton()).disabled(rawPlan == nil)
                    Button {
                        if let s = ScanStore.shared.scans.first(where: { $0.id == room.scanID }) {
                            modelURL = s.bestModelURL
                        }
                    } label: {
                        Label("3D 전체화면", systemImage: "arkit").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(PSSecondaryButton())
                }
                .padding(.horizontal)

                if room.correction.isApplied {
                    correctionSummary
                }
            }
            .padding(.bottom, 24)
        }
        .background(PSTheme.canvas.ignoresSafeArea())
        .navigationTitle(room.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showRename = true } label: { Image(systemName: "pencil") }
            }
        }
        .onAppear { rawPlan = RoomPlanLoader.rawPlan(for: room) }
        .sheet(item: $modelURL) { url in ModelViewerSheet(url: url) }
        .fullScreenCover(isPresented: $showLayout) {
            if let base = correctedPlan {
                LayoutEditorView(projectID: projectID, room: room, basePlan: base) { updated in
                    room = updated
                    projects.updateRoom(updated, in: projectID)
                }
            }
        }
        .sheet(isPresented: $showCorrection) {
            if let rawPlan {
                CorrectionSheet(room: room, rawPlan: rawPlan) { updated in
                    room = updated
                    projects.updateRoom(updated, in: projectID)
                }
            }
        }
        .alert("방 이름", isPresented: $showRename) {
            TextField("방 이름", text: $room.name)
            Button("저장") { projects.updateRoom(room, in: projectID) }
            Button("취소", role: .cancel) {}
        }
    }

    private func metricsGrid(_ m: RoomMetrics) -> some View {
        let items: [(String, String)] = [
            ("면적", String(format: "%.2f ㎡", m.areaM2)),
            ("평", String(format: "%.2f 평", PlanUnits.pyeong(m.areaM2))),
            ("내측 가로×세로", "\(PlanUnits.mmText(m.widthM)) × \(PlanUnits.mmText(m.depthM))"),
            ("천장고", PlanUnits.mmText(m.ceilingM) + " mm"),
            ("둘레", String(format: "%.2f m", m.perimeterM)),
            ("문 / 창", "\(m.doorCount) / \(m.windowCount)"),
            ("벽 순면적", String(format: "%.1f ㎡", m.wallNetM2)),
            ("걸레받이", String(format: "%.1f m", m.baseboardM)),
        ]
        return LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, it in
                VStack(alignment: .leading, spacing: 2) {
                    Text(it.0).font(.caption2).foregroundStyle(.secondary)
                    Text(it.1).font(.subheadline.weight(.semibold).monospacedDigit())
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .background(PSTheme.card, in: RoundedRectangle(cornerRadius: 10))
            }
        }
        .padding(.horizontal)
    }

    private var correctionSummary: some View {
        let c = room.correction
        return VStack(alignment: .leading, spacing: 4) {
            Text("레이저 보정 적용됨").font(.caption.bold()).foregroundStyle(.green)
            Text(String(format: "가로 ×%.4f · 세로 ×%.4f", c.scaleX, c.scaleZ)).font(.caption2)
            if let ch = c.ceilingM { Text("천장고 수동 \(PlanUnits.mmText(ch)) mm").font(.caption2) }
            if !c.note.isEmpty { Text(c.note).font(.caption2).foregroundStyle(.secondary) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(.green.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
        .padding(.horizontal)
    }
}

// MARK: - 레이저 보정 입력

/// 제안서 p11 "현장 레이저 값 스팟 보정" v1: 방의 가로/세로 레이저 실측(mm)을 입력하면
/// 축별 배율을 계산해 도면 전체에 적용. 천장고도 수동 입력 가능.
struct CorrectionSheet: View {
    @Environment(\.dismiss) private var dismiss
    let room: PlanRoomRef
    let rawPlan: PlanData
    let onSave: (PlanRoomRef) -> Void

    @State private var wText = ""
    @State private var dText = ""
    @State private var chText = ""
    @State private var note = ""

    private var scannedW: Double { Double(rawPlan.bounds?.width ?? 0) }
    private var scannedD: Double { Double(rawPlan.bounds?.height ?? 0) }
    private var scannedCH: Double { (rawPlan.ceil_y ?? 2.4) - (rawPlan.floor_y ?? 0) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("스캔 가로", value: PlanUnits.mmText(scannedW) + " mm")
                    LabeledContent("스캔 세로", value: PlanUnits.mmText(scannedD) + " mm")
                    LabeledContent("스캔 천장고", value: PlanUnits.mmText(scannedCH) + " mm")
                } header: { Text("스캔 값 (내측 바운딩)") }

                Section {
                    field("레이저 가로 (mm)", $wText)
                    field("레이저 세로 (mm)", $dText)
                    field("레이저 천장고 (mm)", $chText)
                    TextField("메모 (예: 거실 장변 레이저 2회 평균)", text: $note)
                } header: { Text("레이저 실측 값 — 비우면 해당 축은 보정 안 함") }
                footer: { Text(preview).font(.caption) }

                if room.correction.isApplied {
                    Section {
                        Button("보정 해제 (스캔값으로)", role: .destructive) {
                            var r = room; r.correction = PlanCorrection(); onSave(r); dismiss()
                        }
                    }
                }
            }
            .navigationTitle("레이저 보정")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("취소") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("적용") { apply() } }
            }
            .onAppear {
                let c = room.correction
                if let w = c.laserWidthM { wText = "\(PlanUnits.mm(w))" }
                if let d = c.laserDepthM { dText = "\(PlanUnits.mm(d))" }
                if let ch = c.ceilingM { chText = "\(PlanUnits.mm(ch))" }
                note = c.note
            }
        }
    }

    private func field(_ label: String, _ text: Binding<String>) -> some View {
        HStack {
            Text(label)
            Spacer()
            TextField("mm", text: text).keyboardType(.numberPad)
                .multilineTextAlignment(.trailing).frame(width: 110)
        }
    }

    private func mmValue(_ t: String) -> Double? {
        let digits = t.filter { $0.isNumber }
        guard let v = Double(digits), v > 300, v < 30000 else { return nil }   // 0.3~30m 범위만
        return v / 1000
    }

    private var preview: String {
        var parts: [String] = []
        if let w = mmValue(wText), scannedW > 0 {
            parts.append(String(format: "가로 ×%.4f (%+.1f%%)", w / scannedW, (w / scannedW - 1) * 100))
        }
        if let d = mmValue(dText), scannedD > 0 {
            parts.append(String(format: "세로 ×%.4f (%+.1f%%)", d / scannedD, (d / scannedD - 1) * 100))
        }
        if let ch = mmValue(chText) { parts.append("천장고 \(PlanUnits.mmText(ch))") }
        return parts.isEmpty ? "입력값이 없으면 스캔값 그대로 사용" : parts.joined(separator: " · ")
    }

    private func apply() {
        var c = PlanCorrection()
        if let w = mmValue(wText), scannedW > 0 { c.scaleX = w / scannedW; c.laserWidthM = w }
        if let d = mmValue(dText), scannedD > 0 { c.scaleZ = d / scannedD; c.laserDepthM = d }
        c.ceilingM = mmValue(chText)
        c.note = note
        var r = room; r.correction = c
        onSave(r)
        dismiss()
    }
}
