import SwiftUI
import ARKit

/// Main scanning screen with AR view + overlays
struct ScanningView: View {
    @StateObject private var scanManager = ScanManager()
    @State private var showExportSheet = false
    @State private var exportURL: URL?
    @State private var showServerSheet = false
    @State private var serverURL = "http://moveviz-mac.local:8080"

    var body: some View {
        ZStack {
            // AR Camera View (full screen)
            ARScanView(scanManager: scanManager)
                .edgesIgnoringSafeArea(.all)

            // UI Overlays
            VStack(spacing: 0) {
                // Top: Stats bar
                statsBar
                    .padding(.horizontal, 16)
                    .padding(.top, 8)

                Spacer()

                // Bottom-left: Mini-map
                HStack(alignment: .bottom) {
                    if scanManager.phase != .ready && !scanManager.gridData.isEmpty {
                        MiniMapView(
                            gridData: scanManager.gridData,
                            minX: scanManager.gridMinX,
                            maxX: scanManager.gridMaxX,
                            minY: scanManager.gridMinY,
                            maxY: scanManager.gridMaxY,
                            cameraX: scanManager.cameraX,
                            cameraZ: scanManager.cameraZ,
                            cameraYaw: scanManager.cameraYaw,
                            gridRes: 0.15
                        )
                        .padding(.leading, 16)
                        .transition(.opacity.combined(with: .scale))
                    }

                    Spacer()

                    // Room size estimate
                    if scanManager.estimatedWidth > 0 {
                        roomSizeCard
                            .padding(.trailing, 16)
                            .transition(.opacity)
                    }
                }
                .padding(.bottom, 12)

                // Bottom: Controls
                controlBar
                    .padding(.horizontal, 16)
                    .padding(.bottom, 24)
            }
        }
        .animation(.easeInOut(duration: 0.3), value: scanManager.phase)
        .sheet(isPresented: $showExportSheet) {
            if let url = exportURL {
                ShareSheet(items: [url])
            }
        }
        .sheet(isPresented: $showServerSheet) {
            serverUploadView
        }
    }

    // MARK: - Stats Bar

    private var statsBar: some View {
        HStack(spacing: 16) {
            // App title
            HStack(spacing: 6) {
                Image(systemName: "cube.transparent")
                    .foregroundColor(.cyan)
                Text("MoveViz")
                    .font(.system(size: 16, weight: .bold, design: .rounded))
            }

            Spacer()

            if scanManager.phase != .ready {
                // Point count
                HStack(spacing: 4) {
                    Image(systemName: "circle.fill")
                        .font(.system(size: 6))
                        .foregroundColor(.green)
                    let total = scanManager.pointCount + scanManager.meshVertexCount
                    Text("\(total)")
                        .font(.system(size: 14, weight: .semibold, design: .monospaced))
                    Text("pts")
                        .font(.system(size: 10))
                        .foregroundColor(.secondary)
                }

                // Coverage
                HStack(spacing: 4) {
                    Image(systemName: "square.grid.3x3.fill")
                        .font(.system(size: 10))
                        .foregroundColor(.cyan)
                    Text(String(format: "%.0f%%", scanManager.coveragePercent))
                        .font(.system(size: 14, weight: .semibold, design: .monospaced))
                }

                // LiDAR badge
                if scanManager.hasLiDAR {
                    Text("LiDAR")
                        .font(.system(size: 9, weight: .bold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.purple.opacity(0.8))
                        .cornerRadius(4)
                }

                // Timer
                Text(formatDuration(scanManager.scanDuration))
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundColor(.secondary)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
    }

    // MARK: - Room Size Card

    private var roomSizeCard: some View {
        VStack(alignment: .trailing, spacing: 2) {
            Text("Room Size")
                .font(.system(size: 9, weight: .bold))
                .foregroundColor(.secondary)
            Text(String(format: "%.1f x %.1f m",
                        scanManager.estimatedWidth,
                        scanManager.estimatedDepth))
                .font(.system(size: 16, weight: .bold, design: .monospaced))
                .foregroundColor(.white)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Control Bar

    private var controlBar: some View {
        HStack(spacing: 20) {
            // Reset button
            Button {
                scanManager.resetScan()
            } label: {
                Image(systemName: "arrow.counterclockwise")
                    .font(.system(size: 18))
                    .frame(width: 48, height: 48)
                    .background(.ultraThinMaterial, in: Circle())
            }
            .disabled(scanManager.phase == .ready)
            .opacity(scanManager.phase == .ready ? 0.4 : 1)

            Spacer()

            // Main scan button
            Button {
                switch scanManager.phase {
                case .ready:
                    scanManager.startScan()
                case .scanning:
                    scanManager.stopScan()
                case .done:
                    scanManager.startScan() // restart
                }
            } label: {
                ZStack {
                    Circle()
                        .fill(scanManager.phase == .scanning ? Color.red : Color.cyan)
                        .frame(width: 72, height: 72)

                    if scanManager.phase == .scanning {
                        // Stop icon
                        RoundedRectangle(cornerRadius: 4)
                            .fill(.white)
                            .frame(width: 24, height: 24)
                    } else {
                        // Play / restart icon
                        Image(systemName: scanManager.phase == .done ? "arrow.clockwise" : "play.fill")
                            .font(.system(size: 28))
                            .foregroundColor(.black)
                    }
                }
            }

            Spacer()

            // Export button
            Menu {
                Button {
                    if let url = scanManager.exportPLY() {
                        exportURL = url
                        showExportSheet = true
                    }
                } label: {
                    Label("Share PLY File", systemImage: "square.and.arrow.up")
                }

                Button {
                    showServerSheet = true
                } label: {
                    Label("Upload to Server", systemImage: "icloud.and.arrow.up")
                }
            } label: {
                Image(systemName: "square.and.arrow.up")
                    .font(.system(size: 18))
                    .frame(width: 48, height: 48)
                    .background(.ultraThinMaterial, in: Circle())
            }
            .disabled(scanManager.phase != .done)
            .opacity(scanManager.phase != .done ? 0.4 : 1)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 20))
    }

    // MARK: - Server Upload View

    private var serverUploadView: some View {
        NavigationView {
            VStack(spacing: 20) {
                Text("Upload scan to processing server")
                    .font(.subheadline)
                    .foregroundColor(.secondary)

                TextField("Server URL", text: $serverURL)
                    .textFieldStyle(.roundedBorder)
                    .autocapitalization(.none)
                    .keyboardType(.URL)

                Button {
                    uploadToServer()
                } label: {
                    HStack {
                        Image(systemName: "icloud.and.arrow.up")
                        Text("Upload & Process")
                    }
                    .frame(maxWidth: .infinity)
                    .padding()
                    .background(Color.cyan)
                    .foregroundColor(.black)
                    .cornerRadius(12)
                }

                Text("Server will run extract_floorplan.py\nand return the floor plan")
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)

                Spacer()
            }
            .padding()
            .navigationTitle("Server Upload")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { showServerSheet = false }
                }
            }
        }
    }

    // MARK: - Helpers

    private func formatDuration(_ seconds: TimeInterval) -> String {
        let m = Int(seconds) / 60
        let s = Int(seconds) % 60
        return String(format: "%d:%02d", m, s)
    }

    private func uploadToServer() {
        guard let url = scanManager.exportPLY(),
              let serverEndpoint = URL(string: "\(serverURL)/upload") else { return }

        var request = URLRequest(url: serverEndpoint)
        request.httpMethod = "POST"
        let boundary = UUID().uuidString
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()
        let fileData = try? Data(contentsOf: url)
        guard let fileData = fileData else { return }

        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"scan.ply\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: application/octet-stream\r\n\r\n".data(using: .utf8)!)
        body.append(fileData)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        request.httpBody = body

        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error = error {
                print("Upload error: \(error)")
                return
            }
            if let data = data, let json = try? JSONSerialization.jsonObject(with: data) {
                print("Server response: \(json)")
            }
        }.resume()

        showServerSheet = false
    }
}

// MARK: - Share Sheet

struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
