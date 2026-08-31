//  BOQXLSXExporter.swift
//  PlanShot — 공내역 → 엑셀(xlsx). 외부 라이브러리 없이 OOXML을 직접 쓴다.
//
//  xlsx = ZIP 컨테이너([Content_Types].xml, _rels/.rels, xl/workbook.xml,
//  xl/_rels/workbook.xml.rels, xl/styles.xml, xl/worksheets/sheet1.xml).
//  iOS Foundation에 ZIP 쓰기 API가 없어 STORED(무압축) ZIP을 직접 만든다(CRC32 포함) —
//  Excel·Numbers·Google Sheets 모두 무압축 엔트리를 정상으로 연다.
//  금액 셀은 수식(수량×단가, SUM)으로 넣어 업체가 단가만 채우면 자동 계산되게 한다.

import Foundation

// MARK: - 최소 ZIP writer (STORED)

struct ZipWriter {
    private struct Entry { let name: String; let data: Data; let crc: UInt32; let offset: Int }
    private var body = Data()
    private var entries: [Entry] = []

    private static let crcTable: [UInt32] = (0..<256).map { i -> UInt32 in
        var c = UInt32(i)
        for _ in 0..<8 { c = (c & 1) != 0 ? (0xEDB88320 ^ (c >> 1)) : (c >> 1) }
        return c
    }
    static func crc32(_ data: Data) -> UInt32 {
        var c: UInt32 = 0xFFFFFFFF
        for b in data { c = crcTable[Int((c ^ UInt32(b)) & 0xFF)] ^ (c >> 8) }
        return c ^ 0xFFFFFFFF
    }

    private mutating func le16(_ v: Int) { var x = UInt16(truncatingIfNeeded: v).littleEndian; body.append(Data(bytes: &x, count: 2)) }
    private mutating func le32(_ v: UInt32) { var x = v.littleEndian; body.append(Data(bytes: &x, count: 4)) }

    mutating func add(_ name: String, _ data: Data) {
        let nameData = Data(name.utf8)
        let crc = Self.crc32(data)
        let offset = body.count
        le32(0x04034b50); le16(20); le16(0x0800)           // 시그니처, 버전 2.0, UTF-8 플래그
        le16(0); le16(0); le16(0)                            // 무압축, 시간, 날짜(0 허용)
        le32(crc); le32(UInt32(data.count)); le32(UInt32(data.count))
        le16(nameData.count); le16(0)
        body.append(nameData); body.append(data)
        entries.append(Entry(name: name, data: data, crc: crc, offset: offset))
    }

    mutating func finish() -> Data {
        let cdStart = body.count
        for e in entries {
            let nameData = Data(e.name.utf8)
            le32(0x02014b50); le16(20); le16(20); le16(0x0800); le16(0); le16(0); le16(0)
            le32(e.crc); le32(UInt32(e.data.count)); le32(UInt32(e.data.count))
            le16(nameData.count); le16(0); le16(0); le16(0); le16(0); le32(0)
            le32(UInt32(e.offset))
            body.append(nameData)
        }
        let cdSize = body.count - cdStart
        le32(0x06054b50); le16(0); le16(0); le16(entries.count); le16(entries.count)
        le32(UInt32(cdSize)); le32(UInt32(cdStart)); le16(0)
        return body
    }
}

// MARK: - XLSX

enum BOQXLSXExporter {

    static func export(_ doc: BOQDocument, project: PlanProject) -> URL? {
        let df = DateFormatter(); df.dateFormat = "yyMMdd"
        let safe = project.name.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(df.string(from: Date()))_\(safe)_물량산출서.xlsx")
        try? FileManager.default.removeItem(at: url)
        var z = ZipWriter()
        z.add("[Content_Types].xml", Data(contentTypes.utf8))
        z.add("_rels/.rels", Data(rootRels.utf8))
        z.add("xl/workbook.xml", Data(workbook.utf8))
        z.add("xl/_rels/workbook.xml.rels", Data(workbookRels.utf8))
        z.add("xl/styles.xml", Data(styles.utf8))
        z.add("xl/worksheets/sheet1.xml", Data(sheet(doc, project: project).utf8))
        let data = z.finish()
        do { try data.write(to: url); return url } catch { return nil }
    }

    // 스타일: 0 기본 / 1 굵게(헤더, 회색 배경) / 2 숫자 #,##0 / 3 숫자 0.0 / 4 굵게+숫자 #,##0
    private static let styles = """
    <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
    <numFmts count="1"><numFmt numFmtId="164" formatCode="0.0"/></numFmts>
    <fonts count="2"><font><sz val="10"/><name val="맑은 고딕"/></font><font><b/><sz val="10"/><name val="맑은 고딕"/></font></fonts>
    <fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE7E6E6"/></patternFill></fill></fills>
    <borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"/><right style="thin"/><top style="thin"/><bottom style="thin"/><diagonal/></border></borders>
    <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
    <cellXfs count="5">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>
    <xf numFmtId="3" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
    <xf numFmtId="3" fontId="1" fillId="2" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
    </cellXfs>
    <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
    </styleSheet>
    """

    private static let contentTypes = """
    <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
    <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
    <Default Extension="xml" ContentType="application/xml"/>
    <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
    <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
    <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
    </Types>
    """

    private static let rootRels = """
    <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
    </Relationships>
    """

    private static let workbook = """
    <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
    <sheets><sheet name="물량산출서" sheetId="1" r:id="rId1"/></sheets>
    <calcPr fullCalcOnLoad="1"/>
    </workbook>
    """

    private static let workbookRels = """
    <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
    <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
    </Relationships>
    """

    private static func esc(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
         .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
    }
    private static func col(_ i: Int) -> String {   // 0 → A
        var n = i, s = ""
        repeat { s = String(UnicodeScalar(65 + n % 26)!) + s; n = n / 26 - 1 } while n >= 0
        return s
    }
    private static func str(_ r: Int, _ c: Int, _ v: String, _ style: Int = 0) -> String {
        "<c r=\"\(col(c))\(r)\" s=\"\(style)\" t=\"inlineStr\"><is><t xml:space=\"preserve\">\(esc(v))</t></is></c>"
    }
    private static func num(_ r: Int, _ c: Int, _ v: Double?, _ style: Int = 2) -> String {
        guard let v else { return "<c r=\"\(col(c))\(r)\" s=\"\(style)\"/>" }
        return "<c r=\"\(col(c))\(r)\" s=\"\(style)\"><v>\(v)</v></c>"
    }
    private static func formula(_ r: Int, _ c: Int, _ f: String, _ style: Int = 2) -> String {
        "<c r=\"\(col(c))\(r)\" s=\"\(style)\"><f>\(esc(f))</f></c>"
    }

    private static func sheet(_ doc: BOQDocument, project: PlanProject) -> String {
        var rows: [String] = []
        var r = 1
        func row(_ cells: [String]) { rows.append("<row r=\"\(r)\">" + cells.joined() + "</row>"); r += 1 }

        let dfull = DateFormatter(); dfull.dateFormat = "yyyy.MM.dd"
        row([str(r, 0, "물량 산출서 (공내역)", 1), str(r, 1, project.name), str(r, 2, ""),
             str(r, 3, project.company.isEmpty ? "PlanShot" : project.company),
             str(r, 4, "실측일"), str(r, 5, dfull.string(from: Date()))])
        row([str(r, 0, "수량 = iPhone LiDAR 실측 자동 산출 · 단가는 업체 단가표(빈칸은 직접 입력) · 금액·합계는 수식")])
        row([])
        let headerRow = r
        row(["No", "공종", "품명", "규격", "단위", "수량", "재료비 단가", "재료비 금액", "노무비 단가", "노무비 금액", "합계", "비고"]
                .enumerated().map { str(r, $0.offset, $0.element, 1) })
        let first = r
        for l in doc.lines {
            let isCount = l.unit == "EA" || l.unit == "식"
            row([str(r, 0, l.no), str(r, 1, l.trade), str(r, 2, l.item), str(r, 3, l.spec), str(r, 4, l.unit),
                 num(r, 5, l.qty, isCount ? 2 : 3),
                 num(r, 6, l.matUnit), formula(r, 7, "F\(r)*G\(r)"),
                 num(r, 8, l.labUnit), formula(r, 9, "F\(r)*I\(r)"),
                 formula(r, 10, "H\(r)+J\(r)"), str(r, 11, l.note)])
        }
        let last = r - 1
        if last >= first {
            row([str(r, 0, "", 1), str(r, 1, "합계", 1), str(r, 2, "", 1), str(r, 3, "", 1), str(r, 4, "", 1),
                 str(r, 5, "", 1), str(r, 6, "", 1), formula(r, 7, "SUM(H\(first):H\(last))", 4),
                 str(r, 8, "", 1), formula(r, 9, "SUM(J\(first):J\(last))", 4),
                 formula(r, 10, "SUM(K\(first):K\(last))", 4), str(r, 11, "", 1)])
            let totalRow = r - 1
            if doc.settings.vatPct > 0 {
                row([str(r, 0, ""), str(r, 1, "부가세"), str(r, 2, String(format: "%.0f%%", doc.settings.vatPct)),
                     str(r, 3, ""), str(r, 4, ""), str(r, 5, ""), str(r, 6, ""), str(r, 7, ""), str(r, 8, ""), str(r, 9, ""),
                     formula(r, 10, "K\(totalRow)*\(doc.settings.vatPct / 100)"), str(r, 11, "별도")])
                row([str(r, 0, ""), str(r, 1, "총계", 1), str(r, 2, "", 1), str(r, 3, "", 1), str(r, 4, "", 1), str(r, 5, "", 1),
                     str(r, 6, "", 1), str(r, 7, "", 1), str(r, 8, "", 1), str(r, 9, "", 1),
                     formula(r, 10, "K\(totalRow)+K\(totalRow + 1)", 4), str(r, 11, "", 1)])
            }
        }
        row([])
        for a in doc.assumptions { row([str(r, 0, "· " + a)]) }
        row([str(r, 0, PlanSheetInfo.disclaimer)])
        _ = headerRow

        let cols = """
        <cols><col min="1" max="1" width="6" customWidth="1"/><col min="2" max="2" width="11" customWidth="1"/>
        <col min="3" max="3" width="16" customWidth="1"/><col min="4" max="4" width="13" customWidth="1"/>
        <col min="5" max="5" width="6" customWidth="1"/><col min="6" max="6" width="9" customWidth="1"/>
        <col min="7" max="11" width="12" customWidth="1"/><col min="12" max="12" width="28" customWidth="1"/></cols>
        """
        return """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
        \(cols)<sheetData>\(rows.joined())</sheetData>
        </worksheet>
        """
    }
}
