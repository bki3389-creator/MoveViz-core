//  RootTabView.swift
//  MoveViz — 앱 루트. LiDAR / 카메라(비-LiDAR) 탭으로 스캔 → 맥 전송 → 평면도 결과.
//  (이사 견적 등 앞단 제거, 스캔→결과에 집중)

import SwiftUI
import ARKit

struct RootTabView: View {
    @StateObject private var uploader = ScanUploader()
    @StateObject private var store = ScanStore.shared

    var body: some View {
        TabView {
            RoomPlanTabWrapper(up: uploader)
                .tabItem { Label("즉석(RoomPlan)", systemImage: "square.split.bottomrightquarter.fill") }
            LidarTab(up: uploader, store: store)
                .tabItem { Label("LiDAR→맥", systemImage: "cube.transparent") }
            CameraTabWrapper(up: uploader)
                .tabItem { Label("카메라", systemImage: "camera") }
            SavedScansView(store: store, up: uploader)
                .tabItem { Label("내 스캔", systemImage: "tray.full") }
            SettingsTab(up: uploader)
                .tabItem { Label("설정", systemImage: "gearshape") }
        }
        .sheet(isPresented: $uploader.present) {
            ResultView(up: uploader)
        }
    }
}

// MARK: - LiDAR 탭

struct LidarTab: View {
    @StateObject private var sm = ScanManager()
    @ObservedObject var up: ScanUploader
    @ObservedObject var store: ScanStore
    @State private var modelURL: URL?
    @State private var lastSavedID: String?    // 이번 스캔의 '내 스캔' id (결과 귀속용)
    @State private var exportedOBJ: URL?       // 백그라운드 export 결과 재사용

    var body: some View {
        ZStack(alignment: .bottom) {
            ARScanView(scanManager: sm).ignoresSafeArea()

            VStack(spacing: 12) {
                // 통계
                HStack(spacing: 16) {
                    stat("\(sm.meshVertexCount)", "메시점")
                    stat(String(format: "%.0f%%", sm.coveragePercent), "커버리지")
                    stat(String(format: "%.1f×%.1f", sm.estimatedWidth, sm.estimatedDepth), "크기(m)")
                }
                .padding(10).background(.black.opacity(0.6), in: RoundedRectangle(cornerRadius: 12))
                .foregroundStyle(.white)

                Text(sm.statusMessage).font(.caption).foregroundStyle(.white)
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .background(.black.opacity(0.5), in: Capsule())

                HStack(spacing: 12) {
                    if sm.phase == .scanning {
                        Button(role: .destructive) { sm.stopScan() } label: {
                            Label("정지", systemImage: "stop.fill").frame(maxWidth: .infinity)
                        }.buttonStyle(.borderedProminent)
                    } else {
                        Button { sm.startScan() } label: {
                            Label(sm.phase == .done ? "다시 스캔" : "스캔 시작", systemImage: "play.fill")
                                .frame(maxWidth: .infinity)
                        }.buttonStyle(.borderedProminent)
                    }
                    if sm.phase == .done {
                        Button {
                            // 백그라운드 export 결과 재사용(메인스레드 재-export 금지)
                            if let obj = exportedOBJ ?? sm.exportMeshOBJ() {
                                up.upload(mesh: obj, mode: "lidar",
                                          keyframes: sm.keyframesFolderURL,
                                          linkID: lastSavedID)  // RGB 키프레임 동봉 → 텍스처 매핑
                            }
                        } label: {
                            Label("맥으로 전송 (이미지 포함)", systemImage: "desktopcomputer")
                                .frame(maxWidth: .infinity)
                        }.buttonStyle(.bordered).disabled(!sm.hasLiDAR || exportedOBJ == nil)
                        Button {
                            modelURL = exportedOBJ
                        } label: {
                            Label("3D 메시 보기", systemImage: "view.3d").frame(maxWidth: .infinity)
                        }.buttonStyle(.bordered).disabled(exportedOBJ == nil)
                    }
                }
                if !sm.hasLiDAR {
                    Text("⚠️ 이 기기에 LiDAR가 없습니다 — 카메라(비-LiDAR) 탭을 쓰세요")
                        .font(.caption2).foregroundStyle(.orange)
                }
            }
            .padding(16)
        }
        // 탑다운 미니맵 — 1x 렌즈 화각(세로 ~55°)이 좁게 느껴지는 것을 보완:
        // 스캔된 영역 전체 + 내 위치/방향을 항상 조감으로 표시.
        .overlay(alignment: .topTrailing) {
            if sm.phase == .scanning, !sm.gridData.isEmpty {
                MiniMapView(gridData: sm.gridData,
                            minX: sm.gridMinX, maxX: sm.gridMaxX,
                            minY: sm.gridMinY, maxY: sm.gridMaxY,
                            cameraX: sm.cameraX, cameraZ: sm.cameraZ,
                            cameraYaw: sm.cameraYaw, gridRes: 0.15)
                    .padding(.top, 8)
                    .padding(.trailing, 12)
            }
        }
        .sheet(item: $modelURL) { url in ModelViewerSheet(url: url) }
        // 스캔 완료 즉시 폰에 영구 저장(업로드 실패해도 안 날아가게).
        // OBJ export는 대형 스캔에서 수 초 걸리므로 백그라운드에서 — 메인 프리즈 방지.
        .onChange(of: sm.phase) { newPhase in
            guard newPhase == .done else { return }
            exportedOBJ = nil
            let acc = sm.meshAcc
            let kf = sm.keyframesFolderURL
            let verts = sm.meshVertexCount
            Task.detached(priority: .userInitiated) {
                let url = acc.exportOBJ()
                await MainActor.run {
                    exportedOBJ = url
                    if let url {
                        lastSavedID = store.save(meshURL: url, keyframesFolder: kf,
                                                 vertexCount: verts)
                        sm.statusMessage += lastSavedID != nil ? " · 내 스캔에 저장됨" : " · ⚠️ 저장 실패"
                    }
                }
            }
        }
    }

    private func stat(_ v: String, _ l: String) -> some View {
        VStack(spacing: 2) { Text(v).font(.subheadline.bold().monospacedDigit()); Text(l).font(.caption2) }
    }
}

// MARK: - RoomPlan(온디바이스) 탭 래퍼

struct RoomPlanTabWrapper: View {
    @ObservedObject var up: ScanUploader
    var body: some View {
        if #available(iOS 17.0, *) {
            RoomPlanModeView(up: up)
        } else {
            Text("RoomPlan(즉석 평면도)은 iOS 17+ / LiDAR 기기 필요").multilineTextAlignment(.center).padding()
        }
    }
}

// MARK: - 카메라(비-LiDAR) 탭 래퍼

struct CameraTabWrapper: View {
    @ObservedObject var up: ScanUploader
    var body: some View {
        if #available(iOS 17.0, *) {
            CameraOnlyScanView(uploader: up)
        } else {
            Text("카메라(Object Capture) 모드는 iOS 17+ 필요").padding()
        }
    }
}

// MARK: - 설정 탭 (맥 서버 주소)

struct SettingsTab: View {
    @ObservedObject var up: ScanUploader
    var body: some View {
        NavigationStack {
            Form {
                Section("맥 스토리지 서버") {
                    TextField("http://맥IP:8080", text: $up.serverURL)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .keyboardType(.URL)
                    Button {
                        up.testConnection()
                    } label: {
                        Label("맥 연결 테스트", systemImage: "antenna.radiowaves.left.and.right")
                    }
                    if !up.testResult.isEmpty {
                        Text(up.testResult).font(.caption)
                            .foregroundStyle(up.testResult.hasPrefix("✅") ? .green : .orange)
                    }
                    Text("맥에서 `python ingest_server.py` 실행 후, 같은 WiFi에서 맥 IP 입력. 먼저 '연결 테스트'로 확인.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section("동작") {
                    Label("LiDAR: 메시(OBJ) → 맥 평면도", systemImage: "cube")
                    Label("카메라: 사진 → Object Capture → 맥 평면도", systemImage: "camera")
                    Label("결과는 맥 scans/ 폴더에 저장", systemImage: "folder")
                }
            }
            .navigationTitle("설정")
        }
    }
}
