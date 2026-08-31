//  BOQView.swift
//  PlanShot — 공내역(물량 산출서) 화면: 공종별 수량 확인 · 단가 입력 · 할증/공종 설정 · xlsx 내보내기.

import SwiftUI

struct BOQView: View {
    @Environment(\.dismiss) private var dismiss
    let project: PlanProject
    let rooms: [BOQRoomInput]
    @ObservedObject private var rates = RateTableStore.shared
    @State private var xlsxURL: URL?
    @State private var showSettings = false
    @State private var editingKey: String?

    private var doc: BOQDocument { BOQEngine.build(project: project, rooms: rooms, rates: rates.table) }

    var body: some View {
        NavigationStack {
            let d = doc
            ScrollView {
                VStack(spacing: 14) {
                    PSCard(title: "합계") {
                        HStack(spacing: 6) {
                            PSStat(value: "\(d.lines.count)", label: "항목")
                            PSStat(value: d.hasAnyPrice ? d.matTotalText : "-", label: "재료비 원")
                            PSStat(value: d.hasAnyPrice ? d.labTotalText : "-", label: "노무비 원")
                            PSStat(value: d.hasAnyPrice ? d.grandTotalText : "-", label: "합계 원", tint: PSTheme.accent)
                        }
                        if !d.hasAnyPrice {
                            Text("단가가 비어 있습니다. 항목을 탭해 재료비·노무비 단가를 입력하면 금액이 계산됩니다. (단가는 기기에 저장되어 다음 현장에도 적용)")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }

                    ForEach(groupedTrades(d), id: \.trade) { grp in
                        PSCard(title: grp.trade) {
                            ForEach(grp.lines) { l in
                                Button { editingKey = l.key } label: { lineRow(l) }.buttonStyle(.plain)
                                if l.id != grp.lines.last?.id { Divider() }
                            }
                        }
                    }

                    PSCard(title: "산출 기준") {
                        ForEach(Array(d.assumptions.enumerated()), id: \.offset) { _, a in
                            Text("· " + a).font(.caption).foregroundStyle(.secondary)
                        }
                    }

                    Button {
                        xlsxURL = BOQXLSXExporter.export(d, project: project)
                    } label: { Label("엑셀(xlsx) 만들기 — 표준 내역서 서식", systemImage: "tablecells") }
                        .buttonStyle(PSPrimaryButton())
                    if let url = xlsxURL {
                        ShareLink(item: url) {
                            Label("xlsx 공유 (카카오톡·메일)", systemImage: "square.and.arrow.up").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(PSSecondaryButton())
                    }
                }
                .padding().padding(.bottom, 20)
            }
            .background(PSTheme.canvas.ignoresSafeArea())
            .navigationTitle("공내역 · 물량 산출")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("닫기") { dismiss() } }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSettings = true } label: { Image(systemName: "slider.horizontal.3") }
                }
            }
            .sheet(isPresented: $showSettings) { BOQSettingsSheet() }
            .sheet(item: $editingKey) { key in RateEditSheet(key: key) }
        }
    }

    private struct TradeGroup { let trade: String; let lines: [BOQLine] }
    private func groupedTrades(_ d: BOQDocument) -> [TradeGroup] {
        var order: [String] = [], map: [String: [BOQLine]] = [:]
        for l in d.lines {
            if map[l.trade] == nil { order.append(l.trade) }
            map[l.trade, default: []].append(l)
        }
        return order.map { TradeGroup(trade: $0, lines: map[$0] ?? []) }
    }

    private func lineRow(_ l: BOQLine) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text(l.no).font(.caption.monospacedDigit()).foregroundStyle(.secondary).frame(width: 28, alignment: .leading)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(l.item).font(.subheadline.weight(.semibold))
                    Text(l.spec).font(.caption).foregroundStyle(.secondary)
                }
                Text(l.note).font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
                if l.matUnit != nil || l.labUnit != nil {
                    Text("재료 \(l.matUnitText.isEmpty ? "-" : l.matUnitText) · 노무 \(l.labUnitText.isEmpty ? "-" : l.labUnitText) → \(l.totalText)원")
                        .font(.caption2.monospacedDigit()).foregroundStyle(PSTheme.accent)
                }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(l.qtyText).font(.subheadline.weight(.bold).monospacedDigit())
                Text(l.unit).font(.caption2).foregroundStyle(.secondary)
            }
            Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary).padding(.top, 4)
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
    }
}

extension String: @retroactive Identifiable { public var id: String { self } }

// MARK: - 단가 입력

struct RateEditSheet: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var rates = RateTableStore.shared
    let key: String
    @State private var mat = ""
    @State private var lab = ""

    private var meta: (item: String, spec: String, unit: String)? {
        BOQEngine.catalog.first { $0.key == key }.map { ($0.item, $0.spec, $0.unit) }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if let m = meta {
                        LabeledContent("품명", value: m.item)
                        LabeledContent("규격", value: m.spec)
                        LabeledContent("단위", value: m.unit)
                    }
                }
                Section("단가 (원 / 단위)") {
                    HStack { Text("재료비"); Spacer(); TextField("0", text: $mat).keyboardType(.numberPad).multilineTextAlignment(.trailing).frame(width: 140) }
                    HStack { Text("노무비"); Spacer(); TextField("0", text: $lab).keyboardType(.numberPad).multilineTextAlignment(.trailing).frame(width: 140) }
                    Text("업체 단가는 기기에만 저장됩니다(서버 전송 없음). 비우면 내역서에 공란으로 나갑니다.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("단가 입력")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("취소") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("저장") {
                        var e = rates.table.rates[key] ?? RateEntry()
                        e.matUnit = Double(mat.filter { $0.isNumber })
                        e.labUnit = Double(lab.filter { $0.isNumber })
                        rates.table.rates[key] = e
                        dismiss()
                    }
                }
            }
            .onAppear {
                let e = rates.table[key]
                if let v = e.matUnit { mat = String(Int(v)) }
                if let v = e.labUnit { lab = String(Int(v)) }
            }
        }
    }
}

// MARK: - 할증 / 공종 설정 / CSV 가져오기

struct BOQSettingsSheet: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var rates = RateTableStore.shared
    @State private var csv = ""
    @State private var imported: Int?

    var body: some View {
        NavigationStack {
            Form {
                Section("할증 (%)") {
                    Stepper(value: $rates.table.settings.wallpaperLossPct, in: 0...30, step: 1) {
                        LabeledContent("도배", value: String(format: "%.0f%%", rates.table.settings.wallpaperLossPct))
                    }
                    Stepper(value: $rates.table.settings.floorLossPct, in: 0...30, step: 1) {
                        LabeledContent("바닥재", value: String(format: "%.0f%%", rates.table.settings.floorLossPct))
                    }
                    Stepper(value: $rates.table.settings.tileLossPct, in: 0...30, step: 1) {
                        LabeledContent("타일", value: String(format: "%.0f%%", rates.table.settings.tileLossPct))
                    }
                    Stepper(value: $rates.table.settings.vatPct, in: 0...10, step: 10) {
                        LabeledContent("부가세 표기", value: String(format: "%.0f%%", rates.table.settings.vatPct))
                    }
                }
                Section("포함 공종") {
                    Toggle("철거공사", isOn: $rates.table.settings.includeDemolition)
                    Toggle("도배공사", isOn: $rates.table.settings.includeWallpaper)
                    Toggle("바닥공사", isOn: $rates.table.settings.includeFlooring)
                    Toggle("목공사", isOn: $rates.table.settings.includeCarpentry)
                    Toggle("욕실공사", isOn: $rates.table.settings.includeBathroom)
                    Toggle("현관 타일", isOn: $rates.table.settings.includeEntranceTile)
                }
                Section {
                    TextEditor(text: $csv).frame(height: 110).font(.caption.monospaced())
                    Button("가져오기") { imported = rates.importCSV(csv) }
                    if let n = imported { Text("\(n)개 항목 반영").font(.caption).foregroundStyle(PSTheme.ok) }
                } header: { Text("단가표 붙여넣기 (CSV)") } footer: {
                    Text("한 줄에 `품명,재료비단가,노무비단가` — 예: 벽면 도배,8500,12000. 품명은 내역 항목명과 같아야 합니다.")
                }
            }
            .navigationTitle("산출 설정")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("완료") { dismiss() } } }
        }
    }
}
