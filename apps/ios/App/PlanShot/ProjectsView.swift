//  ProjectsView.swift
//  PlanShot — "현장" 탭: 현장(세대) 목록 + 새 현장 등록. 홈 화면.
//  흐름: 현장 → 방마다 스캔 → 세대 합산 → 도면 PDF → 카톡. (제안서 p2)

import SwiftUI

struct ProjectsView: View {
    @ObservedObject private var store = ProjectStore.shared
    @ObservedObject private var scans = ScanStore.shared
    @State private var showNew = false
    @State private var query = ""

    private var filtered: [PlanProject] {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return store.projects }
        return store.projects.filter {
            $0.name.localizedCaseInsensitiveContains(q) || $0.complex.localizedCaseInsensitiveContains(q)
            || $0.clientName.localizedCaseInsensitiveContains(q) || $0.address.localizedCaseInsensitiveContains(q)
            || $0.pyeongType.localizedCaseInsensitiveContains(q)
        }
    }

    var body: some View {
        NavigationStack {
            Group {
                if store.projects.isEmpty {
                    ScrollView {
                        VStack(spacing: 18) {
                            hero
                            PSEmptyState(icon: "building.2", title: "첫 현장을 만들어 보세요",
                                         message: "현장을 만들고 방마다 2~3분 스캔하면\n상담이 끝나기 전에 치수 도면 PDF가 나옵니다.",
                                         actionTitle: "새 현장") { showNew = true }
                        }
                        .padding()
                    }
                } else {
                    ScrollView {
                        VStack(spacing: 12) {
                            hero
                            ForEach(filtered) { p in
                                NavigationLink(value: p.id) { row(p) }.buttonStyle(.plain)
                                    .contextMenu {
                                        Button(role: .destructive) { store.delete(p) } label: { Label("삭제", systemImage: "trash") }
                                    }
                            }
                            if filtered.isEmpty {
                                Text("검색 결과 없음").font(.footnote).foregroundStyle(.secondary).padding(.top, 20)
                            }
                        }
                        .padding(.horizontal).padding(.bottom, 30)
                    }
                    .searchable(text: $query, prompt: "현장명·단지·고객·평형")
                }
            }
            .background(PSTheme.canvas.ignoresSafeArea())
            .navigationTitle("현장")
            .navigationDestination(for: String.self) { id in ProjectDetailView(projectID: id) }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showNew = true } label: { Image(systemName: "plus.circle.fill").font(.title3) }
                }
            }
            .sheet(isPresented: $showNew) {
                ProjectFormSheet(draft: PlanProject(name: "")) { store.create($0) }
            }
            .onAppear { store.load(); scans.reload() }
        }
    }

    /// 상단 히어로 — 제안서 p2 "스캔 → 도면 → PDF 15분" 한 줄 + 누적 통계.
    private var hero: some View {
        let rooms = store.projects.reduce(0) { $0 + $1.rooms.count }
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text("PlanShot").font(PSTheme.titleFont)
                Text("iPhone 실측 → 도면 → 물량").font(.caption).foregroundStyle(.secondary)
                Spacer()
            }
            PSStepBar(steps: ["방 스캔 2~3분", "치수 도면", "PDF 카톡 전송"], current: 2)
            HStack(spacing: 6) {
                PSStat(value: "\(store.projects.count)", label: "현장")
                PSStat(value: "\(rooms)", label: "실측 방")
                PSStat(value: "\(scans.scans.count)", label: "저장 스캔")
            }
        }
        .padding(16)
        .background(
            LinearGradient(colors: [PSTheme.accent.opacity(0.22), PSTheme.card], startPoint: .topLeading, endPoint: .bottomTrailing),
            in: RoundedRectangle(cornerRadius: PSTheme.radius, style: .continuous))
    }

    private func row(_ p: PlanProject) -> some View {
        let area = p.rooms.reduce(0.0) { acc, r in
            acc + (RoomPlanLoader.plan(for: r).map { PlanMetrics.metrics(of: $0, ceilingOverride: r.correction.ceilingM).areaM2 } ?? 0)
        }
        return HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 10).fill(PSTheme.accentSoft).frame(width: 46, height: 46)
                Image(systemName: "house.fill").foregroundStyle(PSTheme.accent)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(p.name).font(.subheadline.weight(.semibold))
                HStack(spacing: 6) {
                    if !p.clientName.isEmpty { Text(p.clientName) }
                    if !p.complex.isEmpty { Text(p.complex) }
                    if !p.pyeongType.isEmpty { PSBadge(text: p.pyeongType) }
                }
                .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 3) {
                Text(area > 0 ? String(format: "%.1f ㎡", area) : "-")
                    .font(.subheadline.weight(.bold).monospacedDigit())
                Text("방 \(p.rooms.count) · \(dateText(p.updatedAt))").font(.caption2).foregroundStyle(.tertiary)
            }
            Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
        }
        .padding(12)
        .background(PSTheme.card, in: RoundedRectangle(cornerRadius: PSTheme.radius, style: .continuous))
        .contentShape(Rectangle())
    }

    private func dateText(_ d: Date) -> String {
        let f = DateFormatter(); f.dateFormat = "M/d"; return f.string(from: d)
    }
}

// MARK: - 현장 등록/편집 폼

struct ProjectFormSheet: View {
    @Environment(\.dismiss) private var dismiss
    @AppStorage("planshot.company") private var defaultCompany = ""
    @State var draft: PlanProject
    let onSave: (PlanProject) -> Void
    private let isNew: Bool

    init(draft: PlanProject, onSave: @escaping (PlanProject) -> Void) {
        _draft = State(initialValue: draft)
        self.onSave = onSave
        self.isNew = draft.rooms.isEmpty && draft.createdAt.timeIntervalSinceNow > -5
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("현장") {
                    TextField("현장명 (예: 래미안 101동 1203호)", text: $draft.name)
                    TextField("주소", text: $draft.address)
                    HStack {
                        TextField("단지명", text: $draft.complex)
                        TextField("동", text: $draft.dong).frame(width: 60)
                        TextField("호", text: $draft.ho).frame(width: 70)
                    }
                    TextField("평형 (예: 84A / 25평)", text: $draft.pyeongType)
                }
                Section("고객 · 업체") {
                    TextField("고객명", text: $draft.clientName)
                    TextField("우리 업체명 (도면 타이틀블록)", text: $draft.company)
                }
                Section {
                    Text("단지·평형은 같은 단지 재상담 때 검색 키가 됩니다(as-built 실측 DB).")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .navigationTitle(isNew ? "새 현장" : "현장 편집")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("취소") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("저장") {
                        if draft.company.isEmpty { draft.company = defaultCompany }
                        else { defaultCompany = draft.company }
                        onSave(draft); dismiss()
                    }.fontWeight(.semibold)
                }
            }
            .onAppear { if draft.company.isEmpty { draft.company = defaultCompany } }
        }
    }
}
