//  MoveQuoteViews.swift
//  MoveViz — 이사 서비스 화면: 가구 인벤토리 → 이사 견적.
//
//  인벤토리는 '내 스캔'의 검출 가구(furniture.json, 실측 치수)에서 자동 구성.
//  붙박이 설비(변기/세면대/욕조)는 기본 제외. 근접 중복(같은 카테고리 0.8m 내)은
//  보수적으로 1개로 병합 — 검출 중복이 견적을 부풀리지 않게.

import SwiftUI

// MARK: - 스캔 가구 파일 디코딩

private struct VisionFurnitureFile: Decodable {
    struct Item: Decodable {
        let category: String?
        let dims: [Double]?
        let center: [Double]?
    }
    let furniture: [Item]
}

enum InventoryBuilder {
    /// 저장된 모든 스캔에서 인벤토리 구성. (furniture.json 우선, plan.json 폴백)
    @MainActor
    static func build(includeFixtures: Bool) -> [QuoteItem] {
        var out: [QuoteItem] = []
        for scan in ScanStore.shared.scans {
            out += items(from: scan, includeFixtures: includeFixtures)
        }
        return out
    }

    @MainActor
    static func items(from scan: SavedScan, includeFixtures: Bool) -> [QuoteItem] {
        var raw: [(cat: String, w: Double, h: Double, d: Double, cx: Double, cz: Double)] = []
        if scan.hasFurniture,
           let data = try? Data(contentsOf: scan.furnitureURL),
           let file = try? JSONDecoder().decode(VisionFurnitureFile.self, from: data) {
            for it in file.furniture {
                guard let c = it.category, let dm = it.dims, dm.count >= 3 else { continue }
                let ctr = it.center ?? [0, 0, 0]
                raw.append((c, dm[0], dm[1], dm[2],
                            ctr.count > 2 ? ctr[0] : 0, ctr.count > 2 ? ctr[2] : 0))
            }
        } else if scan.hasPlan,
                  let data = try? Data(contentsOf: scan.planURL),
                  let plan = try? JSONDecoder().decode(PlanData.self, from: data) {
            for f in plan.furniture ?? [] {
                let cs = f.corners
                guard cs.count >= 4, let cat = f.category else { continue }
                let w = hypot(cs[1][0] - cs[0][0], cs[1][1] - cs[0][1])
                let d = hypot(cs[3][0] - cs[0][0], cs[3][1] - cs[0][1])
                let cx = cs.map { $0[0] }.reduce(0, +) / Double(cs.count)
                let cz = cs.map { $0[1] }.reduce(0, +) / Double(cs.count)
                raw.append((cat, w, defaultHeight(cat), d, cx, cz))
            }
        }
        if !includeFixtures {
            raw.removeAll { QuoteEngine.fixtures.contains($0.cat.lowercased()) }
        }
        // 보수적 중복 병합: 같은 카테고리 & 중심 0.8m 이내 → 부피 큰 것 하나만
        var merged: [(cat: String, w: Double, h: Double, d: Double, cx: Double, cz: Double)] = []
        for r in raw.sorted(by: { $0.w * $0.h * $0.d > $1.w * $1.h * $1.d }) {
            let dup = merged.contains {
                $0.cat == r.cat && hypot($0.cx - r.cx, $0.cz - r.cz) < 0.8
            }
            if !dup { merged.append(r) }
        }
        return merged.map {
            QuoteItem(category: $0.cat, w: $0.w, h: $0.h, d: $0.d,
                      qty: 1, fromScan: scan.id)
        }
    }

    static func defaultHeight(_ cat: String) -> Double {
        ["bed": 0.5, "sofa": 0.85, "chair": 0.9, "table": 0.75, "desk": 0.75,
         "refrigerator": 1.8, "cabinet": 1.2, "wardrobe": 2.2, "tv": 0.7,
         "appliance": 0.9, "shelf": 1.5, "rack": 1.5][cat.lowercased()] ?? 0.8
    }
}

// MARK: - 인벤토리 화면

struct InventoryView: View {
    @State private var items: [QuoteItem] = []
    @State private var includeFixtures = false
    @State private var showAdd = false

    private var totalVolume: Double { items.reduce(0) { $0 + $1.volume } }

    var body: some View {
        List {
            Section {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("총 짐량(가구)").font(.caption).foregroundStyle(.secondary)
                        Text(String(format: "%.1f ㎥", totalVolume))
                            .font(.title2.bold().monospacedDigit())
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 2) {
                        Text("항목").font(.caption).foregroundStyle(.secondary)
                        Text("\(items.reduce(0) { $0 + $1.qty })개")
                            .font(.title3.bold().monospacedDigit())
                    }
                }
                Toggle("붙박이 설비 포함(변기·세면대·욕조)", isOn: $includeFixtures)
                    .font(.caption)
                    .onChange(of: includeFixtures) { _ in reload() }
            }

            Section("가구 (스캔 실측)") {
                if items.isEmpty {
                    Text("스캔에서 검출된 가구가 없습니다.\n스캔 후 '맥으로 전송'하면 자동으로 채워집니다.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                ForEach($items) { $it in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(it.nameKo).font(.subheadline.weight(.medium))
                            Text(String(format: "%.0f×%.0f×%.0f cm · %.2f㎥%@",
                                        it.w * 100, it.h * 100, it.d * 100, it.unitVolume,
                                        it.fromScan == nil ? " · 수동" : ""))
                                .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Stepper("×\(it.qty)", value: $it.qty, in: 1...20)
                            .font(.caption.monospacedDigit())
                            .fixedSize()
                    }
                }
                .onDelete { items.remove(atOffsets: $0) }
            }

            Section {
                Button { showAdd = true } label: {
                    Label("가구 직접 추가", systemImage: "plus.circle")
                }
            }
        }
        .navigationTitle("가구 인벤토리")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink {
                    QuoteView(items: items)
                } label: {
                    Label("견적", systemImage: "wonsign.circle.fill")
                }
                .disabled(items.isEmpty)
            }
        }
        .sheet(isPresented: $showAdd) { AddItemSheet { items.append($0) } }
        .onAppear { if items.isEmpty { reload() } }
    }

    private func reload() {
        let manual = items.filter { $0.fromScan == nil }
        items = InventoryBuilder.build(includeFixtures: includeFixtures) + manual
    }
}

private struct AddItemSheet: View {
    let onAdd: (QuoteItem) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var pick = 0

    var body: some View {
        NavigationStack {
            List {
                ForEach(Array(QuoteEngine.presetDims.enumerated()), id: \.offset) { i, p in
                    Button {
                        onAdd(QuoteItem(category: p.cat, w: p.w, h: p.h, d: p.d))
                        dismiss()
                    } label: {
                        HStack {
                            Text(QuoteEngine.koName(p.cat))
                            Spacer()
                            Text(String(format: "%.0f×%.0f×%.0f cm", p.w * 100, p.h * 100, p.d * 100))
                                .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        }
                    }
                    .tint(.primary)
                }
            }
            .navigationTitle("가구 추가")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("닫기") { dismiss() } } }
        }
    }
}

// MARK: - 견적 화면

struct QuoteView: View {
    let items: [QuoteItem]
    @State private var opt = QuoteOptions()

    private var result: QuoteResult { QuoteEngine.quote(items: items, options: opt) }

    var body: some View {
        List {
            // 결과 카드
            Section {
                let r = result
                VStack(alignment: .leading, spacing: 10) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(r.truckLabel).font(.title2.bold())
                        Spacer()
                        Text(String(format: "짐량 %.1f㎥ (잡짐 포함)", r.totalVolume))
                            .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    }
                    priceRow("포장이사", r.full, highlight: true)
                    priceRow("반포장", r.half)
                    priceRow("일반(용달+인부)", r.normal)
                    if !r.surchargeNotes.isEmpty {
                        Text(r.surchargeNotes.joined(separator: " · "))
                            .font(.caption2).foregroundStyle(.orange)
                    }
                }
                .padding(.vertical, 6)
            }

            Section("날짜") {
                Toggle("손없는날 / 주말 / 말일", isOn: $opt.goodDay)
                Toggle("성수기 (2–4월, 9–11월)", isOn: $opt.peakSeason)
            }
            Section("건물") {
                Stepper(opt.ladderFloor == 0 ? "사다리차 미사용"
                        : "사다리차 · \(opt.ladderFloor)층",
                        value: $opt.ladderFloor, in: 0...25)
                Toggle("엘리베이터 없음 (계단 작업)", isOn: $opt.noElevator)
            }
            Section("이동 거리 — \(Int(opt.distanceKm))km") {
                Slider(value: $opt.distanceKm, in: 1...400, step: 1)
            }
            Section("특수 항목") {
                Stepper("에어컨 벽걸이 \(opt.airconWall)대", value: $opt.airconWall, in: 0...5)
                Stepper("에어컨 스탠드 \(opt.airconStand)대", value: $opt.airconStand, in: 0...5)
                Toggle("피아노 (업라이트)", isOn: $opt.piano)
            }

            Section("안내") {
                ForEach(QuoteEngine.disclaimers, id: \.self) {
                    Text($0).font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("이사 견적")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                ShareLink(item: shareText()) { Image(systemName: "square.and.arrow.up") }
            }
        }
    }

    @ViewBuilder
    private func priceRow(_ label: String, _ p: PriceRange, highlight: Bool = false) -> some View {
        HStack {
            Text(label).font(highlight ? .subheadline.bold() : .subheadline)
            Spacer()
            Text(p.text)
                .font(highlight ? .headline.monospacedDigit() : .subheadline.monospacedDigit())
                .foregroundStyle(highlight ? Color.accentColor : .primary)
        }
    }

    private func shareText() -> String {
        let r = result
        var s = "[MoveViz 이사 견적 — 3D 스캔 실측 기반]\n"
        s += String(format: "총 짐량 %.1f㎥ → %@\n", r.totalVolume, r.truckLabel)
        s += "포장이사 \(r.full.text) / 반포장 \(r.half.text) / 일반 \(r.normal.text)\n"
        if !r.surchargeNotes.isEmpty { s += "할증: " + r.surchargeNotes.joined(separator: ", ") + "\n" }
        s += "\n[가구 목록]\n"
        for it in items {
            s += String(format: "· %@ ×%d — %.0f×%.0f×%.0f cm\n",
                        it.nameKo, it.qty, it.w * 100, it.h * 100, it.d * 100)
        }
        s += "\n※ " + QuoteEngine.disclaimers[0]
        return s
    }
}
