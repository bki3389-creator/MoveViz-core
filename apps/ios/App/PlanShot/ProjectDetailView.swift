//  ProjectDetailView.swift
//  PlanShot — 현장 상세: 세대 합산 카드 · 방 목록 · 방 스캔 추가 · 공내역 · 도면 PDF/xlsx/DXF 내보내기.

import SwiftUI

struct ProjectDetailView: View {
    let projectID: String
    @ObservedObject private var projects = ProjectStore.shared
    @ObservedObject private var scans = ScanStore.shared
    @AppStorage("planshot.noWatermark") private var noWatermark = false
    @State private var showScan = false
    @State private var showEdit = false
    @State private var showBOQ = false
    @State private var pdfURL: URL?
    @State private var xlsxURL: URL?
    @State private var dxfURL: URL?
    @State private var exporting = false
    @State private var exportError: String?

    private var project: PlanProject? { projects.project(id: projectID) }

    /// 방별 (보정 적용) 평면 + 지표 — 합산 카드·PDF·공내역 공용.
    private var roomPlans: [(room: PlanRoomRef, plan: PlanData, metrics: RoomMetrics)] {
        guard let p = project else { return [] }
        return p.sortedRooms.compactMap { r in
            guard let plan = RoomPlanLoader.plan(for: r) else { return nil }
            let m = PlanMetrics.metrics(of: plan, roomName: r.name,
                                        ceilingOverride: r.correction.ceilingM)
            return (r, plan, m)
        }
    }

    private var summary: ProjectSummary {
        var s = ProjectSummary()
        let rp = roomPlans
        s.roomCount = rp.count
        s.areaM2 = rp.reduce(0) { $0 + $1.metrics.areaM2 }
        s.doors = rp.reduce(0) { $0 + $1.metrics.doorCount }
        s.windows = rp.reduce(0) { $0 + $1.metrics.windowCount }
        s.furniture = rp.reduce(0) { $0 + ($1.plan.furniture?.count ?? 0) }
        let chs = rp.map { $0.metrics.ceilingM }.filter { $0 > 1.8 }
        s.ceilingM = chs.isEmpty ? nil : chs.reduce(0, +) / Double(chs.count)
        return s
    }

    private var watermark: String? { noWatermark ? nil : "PlanShot 무료 체험" }

    var body: some View {
        Group {
            if let p = project {
                ScrollView {
                    VStack(spacing: 14) {
                        PSStepBar(steps: ["방 스캔", "도면 확인", "PDF 전송"],
                                  current: p.rooms.isEmpty ? 0 : (pdfURL == nil ? 1 : 2))
                            .padding(.top, 4)
                        summaryCard(p)
                        roomsCard(p)
                        exportCard(p)
                        infoCard(p)
                    }
                    .padding(.horizontal).padding(.bottom, 30)
                }
                .background(PSTheme.canvas.ignoresSafeArea())
                .navigationTitle(p.name)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { showEdit = true } label: { Image(systemName: "pencil") }
                    }
                }
                .sheet(isPresented: $showEdit) {
                    ProjectFormSheet(draft: p) { projects.update($0) }
                }
                .sheet(isPresented: $showBOQ) {
                    BOQView(project: p, rooms: roomPlans.map { BOQRoomInput(room: $0.room, metrics: $0.metrics) })
                }
                .fullScreenCover(isPresented: $showScan) {
                    if #available(iOS 17.0, *) {
                        RoomScanView(projectID: projectID)
                    } else {
                        VStack(spacing: 12) {
                            Text("RoomPlan 스캔은 iOS 17+ · LiDAR(iPhone Pro) 기기가 필요합니다.")
                                .multilineTextAlignment(.center)
                            Button("닫기") { showScan = false }
                        }.padding()
                    }
                }
            } else {
                Text("현장을 찾을 수 없습니다").foregroundStyle(.secondary)
            }
        }
        .onAppear { scans.reload() }
    }

    // MARK: 카드

    private func summaryCard(_ p: PlanProject) -> some View {
        let s = summary
        return PSCard(title: "세대 합산 · 실측") {
            HStack(spacing: 6) {
                PSStat(value: String(format: "%.1f", s.areaM2), label: "㎡ 합계", tint: PSTheme.accent)
                PSStat(value: String(format: "%.1f", s.pyeong), label: "평")
                PSStat(value: s.ceilingM.map { PlanUnits.mmText($0) } ?? "-", label: "천장고 mm")
                PSStat(value: "\(s.roomCount)", label: "방")
                PSStat(value: "\(s.doors)/\(s.windows)", label: "문/창")
            }
            if s.roomCount == 0 {
                Text("아직 스캔한 방이 없습니다. '방 스캔 추가'로 시작하세요 — 방당 2~3분.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func roomsCard(_ p: PlanProject) -> some View {
        PSCard(title: "방 \(p.rooms.count)") {
            if p.rooms.isEmpty {
                Text("스캔한 방이 여기에 쌓입니다.").font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(p.sortedRooms) { r in
                NavigationLink {
                    RoomDetailView(projectID: projectID, room: r)
                } label: {
                    roomRow(r)
                }
                .buttonStyle(.plain)
                .contextMenu {
                    Button(role: .destructive) { projects.removeRoom(r, from: projectID) } label: {
                        Label("현장에서 제거", systemImage: "trash")
                    }
                }
                if r.id != p.sortedRooms.last?.id { Divider() }
            }
            Button { showScan = true } label: {
                Label("방 스캔 추가 (RoomPlan · LiDAR)", systemImage: "plus.viewfinder")
            }
            .buttonStyle(PSPrimaryButton())
            .padding(.top, 4)
        }
    }

    private func roomRow(_ r: PlanRoomRef) -> some View {
        let m = RoomPlanLoader.plan(for: r).map {
            PlanMetrics.metrics(of: $0, roomName: r.name, ceilingOverride: r.correction.ceilingM)
        }
        return HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 9).fill(PSTheme.accentSoft).frame(width: 40, height: 40)
                Image(systemName: roomIcon(r.name)).foregroundStyle(PSTheme.accent)
            }
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(r.name).font(.subheadline.weight(.semibold))
                    if r.correction.isApplied { PSBadge(text: "레이저 보정", color: PSTheme.ok) }
                }
                if let m {
                    Text("\(PlanUnits.mmText(m.widthM)) × \(PlanUnits.mmText(m.depthM)) · CH \(PlanUnits.mmText(m.ceilingM)) · 문\(m.doorCount) 창\(m.windowCount)")
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    Text("평면도 없음 — 스캔 파일이 삭제되었을 수 있음").font(.caption).foregroundStyle(.orange)
                }
            }
            Spacer()
            if let m {
                Text(String(format: "%.1f ㎡", m.areaM2)).font(.subheadline.weight(.semibold).monospacedDigit())
            }
            Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
    }

    private func roomIcon(_ name: String) -> String {
        if name.contains("거실") { return "sofa.fill" }
        if name.contains("주방") { return "refrigerator.fill" }
        if name.contains("욕실") || name.contains("화장실") { return "shower.fill" }
        if name.contains("침실") || name.contains("안방") { return "bed.double.fill" }
        if name.contains("현관") { return "door.left.hand.closed" }
        if name.contains("발코니") { return "sun.horizon.fill" }
        if name.contains("드레스") { return "tshirt.fill" }
        return "square.split.bottomrightquarter.fill"
    }

    private func exportCard(_ p: PlanProject) -> some View {
        PSCard(title: "내보내기") {
            HStack(spacing: 10) {
                Button { exportPDF(p) } label: {
                    HStack { Label("도면 PDF", systemImage: "doc.richtext"); if exporting { ProgressView().tint(.white) } }
                }
                .buttonStyle(PSPrimaryButton()).disabled(p.rooms.isEmpty || exporting)
                Button { showBOQ = true } label: {
                    Label("공내역", systemImage: "list.number")
                }
                .buttonStyle(PSSecondaryButton()).disabled(p.rooms.isEmpty)
            }
            HStack(spacing: 10) {
                Button { exportXLSX(p) } label: { Label("내역서 xlsx", systemImage: "tablecells") }
                    .buttonStyle(PSSecondaryButton()).disabled(p.rooms.isEmpty)
                Button { exportDXF(p) } label: { Label("CAD DXF", systemImage: "square.on.square.dashed") }
                    .buttonStyle(PSSecondaryButton()).disabled(p.rooms.isEmpty)
            }
            if let url = pdfURL {
                ShareLink(item: url) {
                    Label("PDF 공유 — 카카오톡으로 전송", systemImage: "square.and.arrow.up")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent).tint(PSTheme.ok)
                Text(url.lastPathComponent).font(.caption2).foregroundStyle(.tertiary)
            }
            if let url = xlsxURL {
                ShareLink(item: url) { Label("xlsx 공유", systemImage: "square.and.arrow.up") }
                Text(url.lastPathComponent).font(.caption2).foregroundStyle(.tertiary)
            }
            if let url = dxfURL {
                ShareLink(item: url) { Label("DXF 공유", systemImage: "square.and.arrow.up") }
                Text(url.lastPathComponent).font(.caption2).foregroundStyle(.tertiary)
            }
            if let e = exportError {
                Text(e).font(.caption).foregroundStyle(.orange)
            }
            if !noWatermark {
                Text("무료 체험 — PDF에 워터마크가 표시됩니다. (설정 → 베타 파트너)")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func infoCard(_ p: PlanProject) -> some View {
        PSCard(title: "현장 정보") {
            infoRow("주소", p.address)
            infoRow("단지", [p.complex, p.dong.isEmpty ? "" : p.dong + "동", p.ho.isEmpty ? "" : p.ho + "호"]
                        .filter { !$0.isEmpty }.joined(separator: " "))
            infoRow("평형", p.pyeongType)
            infoRow("고객", p.clientName)
            infoRow("업체", p.company)
        }
    }

    private func infoRow(_ k: String, _ v: String) -> some View {
        HStack {
            Text(k).font(.caption).foregroundStyle(.secondary).frame(width: 40, alignment: .leading)
            Text(v.isEmpty ? "-" : v).font(.subheadline)
            Spacer()
        }
    }

    // MARK: 내보내기

    private func exportPDF(_ p: PlanProject) {
        exporting = true; exportError = nil; pdfURL = nil
        let pages: [PlanPDFPage] = roomPlans.map { rp in
            let sheet = PlanSheetInfo(roomName: rp.room.name, projectName: p.name,
                                      company: p.company, client: p.clientName,
                                      address: p.address, date: Date(),
                                      ceilingM: rp.metrics.ceilingM,
                                      corrected: rp.room.correction.isApplied,
                                      watermark: watermark, showTitleBlock: true)
            return PlanPDFPage(room: rp.room, plan: rp.plan, sheet: sheet, metrics: rp.metrics)
        }
        guard !pages.isEmpty else {
            exporting = false; exportError = "평면도가 있는 방이 없습니다"; return
        }
        let boq = BOQEngine.build(project: p,
                                  rooms: roomPlans.map { BOQRoomInput(room: $0.room, metrics: $0.metrics) },
                                  rates: RateTableStore.shared.table)
        // ImageRenderer는 메인 액터 — 다음 런루프에서 실행해 버튼 상태가 먼저 그려지게.
        DispatchQueue.main.async {
            let url = PlanPDFExporter.export(project: p, pages: pages, summary: summary,
                                             watermark: watermark, boq: boq)
            exporting = false
            if let url { pdfURL = url } else { exportError = "PDF 생성 실패" }
        }
    }

    private func exportXLSX(_ p: PlanProject) {
        exportError = nil; xlsxURL = nil
        let doc = BOQEngine.build(project: p,
                                  rooms: roomPlans.map { BOQRoomInput(room: $0.room, metrics: $0.metrics) },
                                  rates: RateTableStore.shared.table)
        if let url = BOQXLSXExporter.export(doc, project: p) { xlsxURL = url }
        else { exportError = "xlsx 생성 실패" }
    }

    private func exportDXF(_ p: PlanProject) {
        exportError = nil; dxfURL = nil
        let rooms = roomPlans.map { DXFRoom(name: $0.room.name, plan: $0.plan, metrics: $0.metrics) }
        if let url = DXFExporter.export(project: p, rooms: rooms) { dxfURL = url }
        else { exportError = "DXF 생성 실패" }
    }
}
