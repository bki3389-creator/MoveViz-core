//  PlanPDFExporter.swift
//  PlanShot — 현장(세대) 도면 PDF: 요약 1p + 방별 도면 1p씩. A4 세로.
//
//  제안서 p2 흐름의 마지막 단계: "③ 도면·물량 자료 PDF — 카카오톡 전송".
//  SwiftUI ImageRenderer(iOS 16)로 각 페이지 뷰를 CGContext(PDF)에 그린다.
//  무료 체험은 워터마크(제안서 p14) — sheet.watermark 로 FloorPlanView가 그린다.

import SwiftUI
import UIKit

struct PlanPDFPage {
    let room: PlanRoomRef
    let plan: PlanData            // 보정 적용본
    let sheet: PlanSheetInfo
    let metrics: RoomMetrics
}

enum PlanPDFExporter {
    static let a4 = CGSize(width: 595.2, height: 841.8)   // pt

    /// PDF 생성 → 임시 파일 URL (ShareLink/공유시트로 카톡 전송).
    @MainActor
    static func export(project: PlanProject, pages: [PlanPDFPage],
                       summary: ProjectSummary, watermark: String?,
                       boq: BOQDocument? = nil) -> URL? {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent(fileName(project))
        try? FileManager.default.removeItem(at: url)
        var box = CGRect(origin: .zero, size: a4)
        guard let pdf = CGContext(url as CFURL, mediaBox: &box, nil) else { return nil }

        renderPage(SummaryPageView(project: project, pages: pages,
                                   summary: summary, watermark: watermark), into: pdf)
        for p in pages {
            renderPage(PlanPageView(project: project, page: p), into: pdf)
        }
        if let boq {
            renderPage(BOQPageView(project: project, doc: boq, watermark: watermark), into: pdf)
        }
        pdf.closePDF()
        return url
    }

    @MainActor
    private static func renderPage<V: View>(_ view: V, into pdf: CGContext) {
        let content = view
            .frame(width: a4.width, height: a4.height)
            .background(Color.white)
            .environment(\.colorScheme, .light)      // 앱은 다크지만 도면은 흰 종이
        let renderer = ImageRenderer(content: content)
        renderer.proposedSize = ProposedViewSize(a4)
        renderer.render { _, draw in
            pdf.beginPDFPage(nil)
            draw(pdf)
            pdf.endPDFPage()
        }
    }

    static func fileName(_ p: PlanProject) -> String {
        let df = DateFormatter(); df.dateFormat = "yyMMdd"
        let safe = p.name.replacingOccurrences(of: "/", with: "-")
            .replacingOccurrences(of: ":", with: "-")
        return "\(df.string(from: Date()))_\(safe)_실측도면.pdf"
    }
}

// MARK: - 페이지 뷰

/// 1p: 세대 요약 — 방별 면적/평/천장고/문/창, 합계, 면책.
private struct SummaryPageView: View {
    let project: PlanProject
    let pages: [PlanPDFPage]
    let summary: ProjectSummary
    let watermark: String?

    private var df: DateFormatter { let f = DateFormatter(); f.dateFormat = "yyyy.MM.dd"; return f }

    var body: some View {
        ZStack {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("실측 도면 · 세대 요약").font(.system(size: 18, weight: .bold))
                        Text(project.name).font(.system(size: 13, weight: .semibold))
                        if !project.address.isEmpty {
                            Text(project.address).font(.system(size: 10)).foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 3) {
                        Text(project.company.isEmpty ? "PlanShot" : project.company)
                            .font(.system(size: 12, weight: .semibold))
                        if !project.clientName.isEmpty {
                            Text("고객 " + project.clientName).font(.system(size: 10))
                        }
                        Text("실측일 " + df.string(from: Date())).font(.system(size: 10))
                            .foregroundStyle(.secondary)
                    }
                }
                Divider()

                HStack(spacing: 18) {
                    stat(String(format: "%.1f ㎡", summary.areaM2), "전용 실측 합계")
                    stat(String(format: "%.1f 평", summary.pyeong), "평 환산(×0.3025)")
                    stat(summary.ceilingM.map { "CH \(PlanUnits.mmText($0))" } ?? "-", "천장고")
                    stat("\(summary.roomCount)", "방")
                    stat("\(summary.doors) / \(summary.windows)", "문 / 창")
                }
                .padding(12)
                .background(Color(white: 0.95), in: RoundedRectangle(cornerRadius: 8))

                VStack(spacing: 0) {
                    row(["실명", "면적 ㎡", "평", "가로×세로 mm", "천장고", "문", "창", "벽 순면적 ㎡", "보정"],
                        header: true)
                    ForEach(Array(pages.enumerated()), id: \.offset) { i, p in
                        let m = p.metrics
                        row([p.room.name,
                             String(format: "%.2f", m.areaM2),
                             String(format: "%.2f", PlanUnits.pyeong(m.areaM2)),
                             "\(PlanUnits.mmText(m.widthM)) × \(PlanUnits.mmText(m.depthM))",
                             PlanUnits.mmText(m.ceilingM),
                             "\(m.doorCount)", "\(m.windowCount)",
                             String(format: "%.1f", m.wallNetM2),
                             p.room.correction.isApplied ? "레이저" : "-"],
                            header: false, shade: i % 2 == 1)
                    }
                    row(["합계", String(format: "%.2f", summary.areaM2),
                         String(format: "%.2f", summary.pyeong), "", "", "\(summary.doors)",
                         "\(summary.windows)",
                         String(format: "%.1f", pages.reduce(0) { $0 + $1.metrics.wallNetM2 }), ""],
                        header: true)
                }
                .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.gray.opacity(0.5), lineWidth: 0.6))

                Text("벽 순면적 = 둘레 × 천장고 − 개구부(문 2.1m·창 1.2m 가정). 물량 산출(공내역)의 기초 수량이며, 마감 두께·몰딩은 반영하지 않았습니다.")
                    .font(.system(size: 8.5)).foregroundStyle(.secondary)

                Spacer()

                VStack(alignment: .leading, spacing: 3) {
                    Text(PlanSheetInfo.disclaimer).font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(Color.orange)
                    Text("iPhone LiDAR(Apple RoomPlan) 실측. 방별 도면은 다음 페이지. 레이저 보정 표기는 해당 실의 가로/세로를 현장 레이저 값으로 맞춘 것입니다.")
                        .font(.system(size: 8)).foregroundStyle(.secondary)
                }
            }
            .padding(36)

            if let wm = watermark, !wm.isEmpty {
                Text(wm).font(.system(size: 64, weight: .heavy))
                    .foregroundStyle(Color.black.opacity(0.08))
                    .rotationEffect(.degrees(-30))
            }
        }
        .foregroundStyle(Color.black)
    }

    private func stat(_ v: String, _ l: String) -> some View {
        VStack(spacing: 2) {
            Text(v).font(.system(size: 13, weight: .bold).monospacedDigit())
            Text(l).font(.system(size: 8)).foregroundStyle(.secondary)
        }.frame(maxWidth: .infinity)
    }

    private func row(_ cells: [String], header: Bool, shade: Bool = false) -> some View {
        let widths: [CGFloat] = [64, 52, 40, 100, 50, 26, 26, 66, 40]
        return HStack(spacing: 0) {
            ForEach(Array(cells.enumerated()), id: \.offset) { i, c in
                Text(c)
                    .font(.system(size: 8.5, weight: header ? .semibold : .regular).monospacedDigit())
                    .frame(width: i < widths.count ? widths[i] : 50, alignment: i == 0 ? .leading : .trailing)
                    .padding(.horizontal, 3)
            }
        }
        .padding(.vertical, 4)
        .background(header ? Color(white: 0.9) : (shade ? Color(white: 0.97) : Color.white))
    }
}

/// 2p~: 방별 도면 — FloorPlanView(도면 모드) + 실 지표.
private struct PlanPageView: View {
    let project: PlanProject
    let page: PlanPDFPage

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(page.room.name).font(.system(size: 18, weight: .bold))
                Text(project.name).font(.system(size: 11)).foregroundStyle(.secondary)
                Spacer()
                Text(project.company.isEmpty ? "PlanShot" : project.company)
                    .font(.system(size: 11, weight: .semibold))
            }
            .padding(.horizontal, 30).padding(.top, 30)

            FloorPlanView(plan: page.plan, sheet: page.sheet, interactive: false)
                .frame(width: PlanPDFExporter.a4.width - 40, height: 560)
                .padding(.horizontal, 20)

            let m = page.metrics
            HStack(spacing: 14) {
                cell("면적", String(format: "%.2f ㎡ · %.2f평", m.areaM2, PlanUnits.pyeong(m.areaM2)))
                cell("내측", "\(PlanUnits.mmText(m.widthM)) × \(PlanUnits.mmText(m.depthM))")
                cell("천장고", PlanUnits.mmText(m.ceilingM))
                cell("둘레", String(format: "%.2f m", m.perimeterM))
                cell("문/창", "\(m.doorCount) / \(m.windowCount)")
                cell("벽 순면적", String(format: "%.1f ㎡", m.wallNetM2))
            }
            .padding(.horizontal, 30)
            Spacer(minLength: 0)
        }
        .foregroundStyle(Color.black)
    }

    private func cell(_ k: String, _ v: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(k).font(.system(size: 8)).foregroundStyle(.secondary)
            Text(v).font(.system(size: 10, weight: .semibold).monospacedDigit())
        }
    }
}

/// 마지막 p: 공내역(물량 산출서) — 표준 내역서 서식(공종·품명·규격·단위·수량·재료비·노무비·합계·비고).
private struct BOQPageView: View {
    let project: PlanProject
    let doc: BOQDocument
    let watermark: String?

    var body: some View {
        ZStack {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .firstTextBaseline) {
                    Text("물량 산출서 (공내역)").font(.system(size: 18, weight: .bold))
                    Text(project.name).font(.system(size: 11)).foregroundStyle(.secondary)
                    Spacer()
                    Text(project.company.isEmpty ? "PlanShot" : project.company)
                        .font(.system(size: 11, weight: .semibold))
                }
                Text("수량 = 실측 자동 산출 · 단가·금액 = 업체 단가표(미입력은 공란)")
                    .font(.system(size: 9)).foregroundStyle(.secondary)

                VStack(spacing: 0) {
                    boqRow(["No", "공종", "품명", "규격", "단위", "수량", "재료비 단가", "재료비 금액",
                            "노무비 단가", "노무비 금액", "합계", "비고"], header: true)
                    ForEach(Array(doc.lines.enumerated()), id: \.offset) { i, l in
                        boqRow([l.no, l.trade, l.item, l.spec, l.unit, l.qtyText,
                                l.matUnitText, l.matAmountText, l.labUnitText, l.labAmountText,
                                l.totalText, l.note], header: false, shade: i % 2 == 1)
                    }
                    boqRow(["", "합계", "", "", "", "", "", doc.matTotalText, "", doc.labTotalText,
                            doc.grandTotalText, ""], header: true)
                }
                .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.gray.opacity(0.5), lineWidth: 0.6))

                VStack(alignment: .leading, spacing: 3) {
                    ForEach(Array(doc.assumptions.enumerated()), id: \.offset) { _, a in
                        Text("· " + a).font(.system(size: 8)).foregroundStyle(.secondary)
                    }
                }
                Spacer()
                Text(PlanSheetInfo.disclaimer + " · 물량은 개략 실측 기반이며 손율·할증은 업체 기준으로 조정하십시오.")
                    .font(.system(size: 8.5, weight: .semibold)).foregroundStyle(Color.orange)
            }
            .padding(28)

            if let wm = watermark, !wm.isEmpty {
                Text(wm).font(.system(size: 64, weight: .heavy))
                    .foregroundStyle(Color.black.opacity(0.08))
                    .rotationEffect(.degrees(-30))
            }
        }
        .foregroundStyle(Color.black)
    }

    private func boqRow(_ cells: [String], header: Bool, shade: Bool = false) -> some View {
        let widths: [CGFloat] = [18, 44, 68, 58, 24, 40, 44, 48, 44, 48, 50, 44]
        return HStack(spacing: 0) {
            ForEach(Array(cells.enumerated()), id: \.offset) { i, c in
                Text(c)
                    .font(.system(size: 7.5, weight: header ? .semibold : .regular).monospacedDigit())
                    .lineLimit(1).minimumScaleFactor(0.7)
                    .frame(width: i < widths.count ? widths[i] : 40,
                           alignment: (i >= 5 && i <= 10) ? .trailing : .leading)
                    .padding(.horizontal, 2)
            }
        }
        .padding(.vertical, 3.5)
        .background(header ? Color(white: 0.9) : (shade ? Color(white: 0.97) : Color.white))
    }
}
