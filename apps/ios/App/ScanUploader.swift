//  ScanUploader.swift
//  MoveViz — 스캔(메시/USDZ) + 키프레임을 맥 ingest 서버로 업로드 후 결과 폴링.
//
//  맥(같은 WiFi)이 스토리지+처리. 폰은 POST /upload → /result/<id> 폴링 → 평면도 결과 표시.

import Foundation

struct ScanSummary: Decodable {
    let area_m2: Double?
    let doors: Int?
    let windows: Int?
    let rooms: Int?
    let furniture: Int?
    let walls: Int?
    let space_type: String?       // 비전 추론 공간유형(home/office/cafe/retail/warehouse)
    let space_detail: String?
    let furniture_vision: Int?    // OWLv2 비전 가구 수
    let error: String?            // 서버가 done이어도 비전 단계 실패를 여기 표면화
}
struct ScanResult: Decodable {
    let status: String
    let summary: ScanSummary?
    let plan_png: String?
    let plan_svg: String?
    let textured_png: String?
    let furniture_png: String?    // 가구 비전 탑뷰(회전박스+라벨)
    let colored_usdz: String?     // 텍스처드 3D(정점색 USDZ) — 폰 QuickLook용
    let raw: String?              // 벡터 평면도 plan.json 경로(네이티브 렌더링용)
    let furniture_json: String?   // 가구 실측(치수·중심) — 인벤토리/견적용
    let error: String?
    let id: String?
}

@MainActor
final class ScanUploader: ObservableObject {
    // .local 호스트네임 = mDNS로 자동 해석 → 맥 IP가 바뀌어도 안 깨짐(같은 WiFi면).
    // IP가 안 되면 설정에서 직접 IP 입력 가능. UserDefaults에 영속화.
    @Published var serverURL = UserDefaults.standard.string(forKey: "serverURL")
        ?? "http://moveviz-mac.local:8080" {
        didSet { UserDefaults.standard.set(serverURL, forKey: "serverURL") }
    }
    @Published var status = "대기"
    @Published var busy = false
    @Published var done = false
    @Published var scanID = ""
    @Published var planImageURL = ""    // 전체 URL(서버 PNG)
    @Published var texturedImageURL = "" // 텍스처드 3D PNG
    @Published var furnitureImageURL = "" // 가구 비전 탑뷰 PNG
    @Published var coloredUSDZURL = ""    // 텍스처드 3D USDZ(서버)
    @Published var summary: ScanSummary?
    @Published var planData: PlanData?   // 벡터 평면도(plan.json) — 네이티브 렌더링
    @Published var present = false       // 결과 시트 표시
    @Published var testResult = ""       // 연결 테스트 결과
    // 이번 업로드가 어느 저장 스캔에서 왔는지 — 결과(텍스처드 USDZ)를 그 폴더에 귀속.
    var linkedScanID: String?

    /// 맥 /health 핑 — iOS 로컬네트워크 권한 팝업 유발 + 도달 가능 여부 즉시 확인.
    func testConnection() {
        testResult = "테스트 중…"
        Task {
            guard let url = URL(string: serverURL + "/health") else { testResult = "❌ 주소 형식 오류"; return }
            do {
                var req = URLRequest(url: url); req.timeoutInterval = 6
                let (data, resp) = try await URLSession.shared.data(for: req)
                let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                let body = String(data: data, encoding: .utf8) ?? ""
                testResult = code == 200 ? "✅ 맥 연결 OK \(body)" : "⚠️ 응답 코드 \(code)"
            } catch {
                testResult = "❌ 못 닿음: \(error.localizedDescription)\n→ 같은 WiFi인지 + 설정>MoveViz>로컬네트워크 ON 확인"
            }
        }
    }

    func upload(mesh: URL, mode: String, keyframes: URL? = nil, linkID: String? = nil) {
        present = true; done = false; summary = nil; planData = nil
        linkedScanID = linkID
        planImageURL = ""; texturedImageURL = ""; furnitureImageURL = ""; coloredUSDZURL = ""
        Task { await run(mesh: mesh, mode: mode, keyframes: keyframes) }
    }

    /// 서버의 모델 파일(USDZ 등)을 임시폴더로 받아 로컬 URL 반환(QuickLook은 로컬 파일 필요).
    /// 통메모리 적재 대신 디스크 스트리밍 다운로드(대형 USDZ 메모리 압박 방지).
    func downloadToTemp(_ urlString: String) async -> URL? {
        guard let url = URL(string: urlString) else { return nil }
        do {
            let (tmp, resp) = try await URLSession.shared.download(from: url)
            guard (resp as? HTTPURLResponse).map({ $0.statusCode == 200 }) ?? true else { return nil }
            // 파일명을 스캔마다 고유하게 — 항상 "colored.usdz"면 URL(=뷰 identity)이
            // 같아져 다음 스캔에서도 이전 3D 모델이 표시되는 버그가 있었음.
            let dest = FileManager.default.temporaryDirectory
                .appendingPathComponent("\(UUID().uuidString.prefix(8))_\(url.lastPathComponent)")
            try? FileManager.default.removeItem(at: dest)
            try FileManager.default.moveItem(at: tmp, to: dest)
            return dest
        } catch { return nil }
    }

    /// RoomPlan(온디바이스) 결과를 맥으로 — USDZ + 벽/가구 JSON. HTML 갤러리에서 비교용.
    func uploadRoomPlan(usdz: URL?, roomJSON: Data, linkID: String? = nil) {
        present = true; done = false; summary = nil; planData = nil
        linkedScanID = linkID
        planImageURL = ""; texturedImageURL = ""; furnitureImageURL = ""; coloredUSDZURL = ""
        Task { await runRoomPlan(usdz: usdz, roomJSON: roomJSON) }
    }

    private func runRoomPlan(usdz: URL?, roomJSON: Data) async {
        busy = true; status = "RoomPlan 결과 맥으로 업로드 중…"
        guard let url = URL(string: serverURL + "/upload") else { fail("서버 주소 오류"); return }
        let boundary = "Boundary-\(UUID().uuidString)"
        var req = URLRequest(url: url); req.httpMethod = "POST"; req.timeoutInterval = 120
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        var body = Data()
        body.appendStr("--\(boundary)\r\n")
        body.appendStr("Content-Disposition: form-data; name=\"mode\"\r\n\r\nroomplan\r\n")
        let usdzData = usdz.flatMap { try? Data(contentsOf: $0) } ?? Data("none".utf8)
        body.appendStr("--\(boundary)\r\n")
        body.appendStr("Content-Disposition: form-data; name=\"file\"; filename=\"room.usdz\"\r\n")
        body.appendStr("Content-Type: application/octet-stream\r\n\r\n")
        body.append(usdzData); body.appendStr("\r\n")
        body.appendStr("--\(boundary)\r\n")
        body.appendStr("Content-Disposition: form-data; name=\"roomdata\"; filename=\"roomplan.json\"\r\n")
        body.appendStr("Content-Type: application/json\r\n\r\n")
        body.append(roomJSON); body.appendStr("\r\n")
        body.appendStr("--\(boundary)--\r\n")
        do {
            let (data, _) = try await URLSession.shared.upload(for: req, from: body)
            let r = try JSONDecoder().decode(ScanResult.self, from: data)
            guard let id = r.id else { fail("업로드 응답 오류"); return }
            scanID = id; status = "맥에서 RoomPlan 평면도 생성 중…"
            await poll(id: id)
        } catch {
            fail("업로드 실패: \(error.localizedDescription)")
        }
    }

    /// 폴더를 zip(.forUploading)으로 묶어 Data 반환.
    private func zipData(of folder: URL) -> Data? {
        let coord = NSFileCoordinator(); var err: NSError?; var data: Data?
        coord.coordinate(readingItemAt: folder, options: .forUploading, error: &err) { tmp in
            data = try? Data(contentsOf: tmp)
        }
        return data
    }

    /// 키프레임 폴더(이미지+poses.json)를 zip으로 묶어 업로드(카메라/이미지 기반).
    func uploadKeyframes(folder: URL, linkID: String? = nil) {
        let coord = NSFileCoordinator()
        var nserr: NSError?
        var zipURL: URL?
        coord.coordinate(readingItemAt: folder, options: .forUploading, error: &nserr) { tmp in
            let dest = FileManager.default.temporaryDirectory.appendingPathComponent("keyframes.zip")
            try? FileManager.default.removeItem(at: dest)
            do { try FileManager.default.copyItem(at: tmp, to: dest); zipURL = dest } catch {}
        }
        if let z = zipURL {
            // linkID를 upload()에 그대로 전달 — upload()가 linkedScanID를 재설정하므로
            // 여기서 미리 설정해봤자 덮어써진다(버그였음).
            upload(mesh: z, mode: "camera", linkID: linkID)
        } else {
            present = true; status = "이미지 압축 실패: \(nserr?.localizedDescription ?? "")"
        }
    }

    private func run(mesh: URL, mode: String, keyframes: URL? = nil) async {
        busy = true; status = "맥으로 업로드 중…"
        guard let url = URL(string: serverURL + "/upload") else { fail("서버 주소 오류"); return }
        let boundary = "Boundary-\(UUID().uuidString)"
        var req = URLRequest(url: url); req.httpMethod = "POST"
        req.timeoutInterval = 180
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()
        body.appendStr("--\(boundary)\r\n")
        body.appendStr("Content-Disposition: form-data; name=\"mode\"\r\n\r\n\(mode)\r\n")
        guard let fileData = try? Data(contentsOf: mesh) else { fail("메시 읽기 실패"); return }
        body.appendStr("--\(boundary)\r\n")
        body.appendStr("Content-Disposition: form-data; name=\"file\"; filename=\"\(mesh.lastPathComponent)\"\r\n")
        body.appendStr("Content-Type: application/octet-stream\r\n\r\n")
        body.append(fileData); body.appendStr("\r\n")
        // RGB 키프레임(이미지 매핑/텍스처용) 동봉
        if let kf = keyframes, let kfData = zipData(of: kf) {
            body.appendStr("--\(boundary)\r\n")
            body.appendStr("Content-Disposition: form-data; name=\"keyframes\"; filename=\"keyframes.zip\"\r\n")
            body.appendStr("Content-Type: application/zip\r\n\r\n")
            body.append(kfData); body.appendStr("\r\n")
        }
        body.appendStr("--\(boundary)--\r\n")

        do {
            let (data, _) = try await URLSession.shared.upload(for: req, from: body)
            let r = try JSONDecoder().decode(ScanResult.self, from: data)
            guard let id = r.id else { fail("업로드 응답 오류"); return }
            scanID = id; status = "맥에서 평면도 처리 중…"
            await poll(id: id)
        } catch {
            fail("업로드 실패: \(error.localizedDescription)\n→ 맥 주소 확인(설정 > 맥 연결 테스트). 스캔은 '내 스캔'에 저장돼 있어 나중에 재전송 가능.")
        }
    }

    private func poll(id: String) async {
        // 서버 처리(평면도+비전+포토그래메트리)는 60초를 훌쩍 넘을 수 있음 →
        // 시간 예산 5분 + 지수 백오프(1.5s→최대 8s). 반복 횟수가 아니라 경과 시간으로 판정.
        let budget: TimeInterval = 300
        let start = Date()
        var interval: TimeInterval = 1.5
        while Date().timeIntervalSince(start) < budget {
            try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
            interval = min(interval * 1.25, 8)
            guard let url = URL(string: "\(serverURL)/result/\(id)") else { break }
            guard let (data, resp) = try? await URLSession.shared.data(from: url) else {
                status = "맥 응답 대기 중… (네트워크 재시도)"; continue
            }
            if let code = (resp as? HTTPURLResponse)?.statusCode, code != 200 {
                status = "맥 응답 대기 중… (HTTP \(code))"; continue
            }
            guard let r = try? JSONDecoder().decode(ScanResult.self, from: data) else { continue }
            if r.status == "done" {
                summary = r.summary
                if let p = r.plan_png { planImageURL = serverURL + p }
                if let t = r.textured_png { texturedImageURL = serverURL + t }
                if let f = r.furniture_png { furnitureImageURL = serverURL + f }
                if let u = r.colored_usdz { coloredUSDZURL = serverURL + u }
                await fetchPlanData(id: id, rawPath: r.raw)
                await fetchFurniture(id: id, path: r.furniture_json)
                status = "완료"; done = true; busy = false
                return
            } else if r.status == "error" {
                fail("처리 오류: \(r.error ?? "")"); return
            } else {
                let elapsed = Int(Date().timeIntervalSince(start))
                status = "맥에서 처리 중… (\(r.status), \(elapsed)s)"
            }
        }
        fail("시간 초과(5분) — 맥이 응답하지 않음.\n→ 설정 > 맥 연결 테스트로 주소 확인. 스캔은 '내 스캔'에 저장됨(재전송 가능).")
    }

    /// 벡터 평면도(plan.json) 가져오기 — 네이티브 FloorPlanView 렌더링용.
    private func fetchPlanData(id: String, rawPath: String?) async {
        let path = rawPath ?? "/scans/\(id)/plan.json"
        guard let url = URL(string: serverURL + path),
              let (data, resp) = try? await URLSession.shared.data(from: url),
              (resp as? HTTPURLResponse)?.statusCode == 200 else { planData = nil; return }
        planData = try? JSONDecoder().decode(PlanData.self, from: data)
        // '내 스캔'에서 온 업로드면 평면도를 그 스캔 폴더에 귀속 → 오프라인에서 다시 보기.
        if planData != nil, let lid = linkedScanID {
            ScanStore.shared.attachPlan(data, toScanID: lid)
        }
    }

    /// 가구 실측 목록(furniture_vision.json) — 인벤토리/이사견적의 입력으로 귀속 저장.
    private func fetchFurniture(id: String, path: String?) async {
        let p = path ?? "/scans/\(id)/furniture_vision.json"
        guard let lid = linkedScanID,
              let url = URL(string: serverURL + p),
              let (data, resp) = try? await URLSession.shared.data(from: url),
              (resp as? HTTPURLResponse)?.statusCode == 200 else { return }
        ScanStore.shared.attachFurniture(data, toScanID: lid)
    }

    private func fail(_ m: String) { status = m; busy = false; done = false }
}

private extension Data {
    mutating func appendStr(_ s: String) { if let d = s.data(using: .utf8) { append(d) } }
}
