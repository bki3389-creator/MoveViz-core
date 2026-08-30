//  RoomPlanModeView.swift
//  MoveViz — RoomPlan 온디바이스 모드 (맥 불필요).
//  스캔 → 폰에서 바로: 2D 평면도 + 깔끔한 가구(Apple) + 텍스처 3D(USDZ/QuickLook).
//  폴리캠처럼 즉석으로 결과가 나온다. (iOS 17+ / LiDAR 기기)

import SwiftUI
import RoomPlan

@available(iOS 17.0, *)
struct RoomPlanModeView: View {
    @ObservedObject var up: ScanUploader
    @StateObject private var mgr = RoomPlanSpikeManager()
    @State private var show3D: URL?

    /// RoomPlan 결과 → 서버 비교용 JSON(벽/문/창/가구).
    private func roomJSON() -> Data {
        func segs(_ a: [[CGPoint]]) -> [[[Double]]] { a.map { $0.map { [Double($0.x), Double($0.y)] } } }
        let furn = mgr.furnitureList.map { f -> [String: Any] in
            ["category": f.cat, "cx": Double(f.cx), "cz": Double(f.cz),
             "w": Double(f.w), "d": Double(f.d), "yaw": Double(f.yaw)]
        }
        let obj: [String: Any] = ["area_m2": mgr.floorAreaM2, "walls": segs(mgr.walls2D),
                                  "doors": segs(mgr.doors2D), "windows": segs(mgr.windows2D), "furniture": furn]
        return (try? JSONSerialization.data(withJSONObject: obj)) ?? Data()
    }

    var body: some View {
        ZStack {
            if mgr.done {
                results
            } else {
                capture
            }
        }
        .sheet(item: $show3D) { url in ModelViewerSheet(url: url) }
    }

    // MARK: - 스캔 화면
    private var capture: some View {
        ZStack(alignment: .bottom) {
            RoomCaptureViewRepresentable(manager: mgr).ignoresSafeArea()
            VStack(spacing: 12) {
                Text(mgr.status).font(.footnote.weight(.semibold)).foregroundStyle(.white)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(.black.opacity(0.55), in: Capsule())
                if mgr.isScanning {
                    Text("벽 \(mgr.wallCount) · 문 \(mgr.doorCount) · 창 \(mgr.windowCount) · 가구 \(mgr.objectCount)")
                        .font(.caption.monospacedDigit()).foregroundStyle(.white)
                        .padding(.horizontal, 10).padding(.vertical, 6)
                        .background(.black.opacity(0.5), in: Capsule())
                }
                if mgr.isScanning {
                    Button(role: .destructive, action: mgr.stop) {
                        Label("스캔 종료 → 평면도", systemImage: "stop.fill").frame(maxWidth: .infinity)
                    }.buttonStyle(.borderedProminent)
                } else {
                    Button(action: mgr.start) {
                        Label("스캔 시작 (방을 한 바퀴)", systemImage: "play.fill").frame(maxWidth: .infinity)
                    }.buttonStyle(.borderedProminent)
                }
            }.padding(16)
        }
    }

    // MARK: - 결과 화면
    private var results: some View {
        ScrollView {
            VStack(spacing: 16) {
                HStack(spacing: 16) {
                    stat("\(String(format: "%.1f", mgr.floorAreaM2))㎡", "면적")
                    stat("\(mgr.wallCount)", "벽")
                    stat("\(mgr.doorCount)", "문")
                    stat("\(mgr.windowCount)", "창")
                    stat("\(mgr.objectCount)", "가구")
                }.padding(.top, 8)

                Text("평면도 (온디바이스)").font(.caption.bold()).foregroundStyle(.secondary)
                // 축 정렬 + 건축 도면식 렌더러 (벽 밴드·치수선·문/창 심볼).
                // 어댑터 실패(벽 부족) 시 기존 선분 뷰로 폴백.
                if let plan = PlanData.fromRoomPlan(
                    walls: mgr.walls2D, doors: mgr.doors2D, windows: mgr.windows2D,
                    furniture: mgr.furnitureList.map {
                        (cat: $0.cat, ko: $0.name, cx: Double($0.cx), cz: Double($0.cz),
                         w: Double($0.w), d: Double($0.d), yaw: Double($0.yaw))
                    }) {
                    VStack(spacing: 4) {
                        FloorPlanView(plan: plan)
                            .frame(height: 380)
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                            .overlay(RoundedRectangle(cornerRadius: 12)
                                .stroke(.quaternary, lineWidth: 1))
                        Text("핀치 확대 · 드래그 이동 · 더블탭 초기화 · 치수 mm")
                            .font(.caption2).foregroundStyle(.tertiary)
                    }
                    .padding(.horizontal)
                } else {
                    FloorPlan2D(mgr: mgr)
                        .frame(height: 320)
                        .background(Color(.secondarySystemBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                        .padding(.horizontal)
                }

                if mgr.usdzURL != nil {
                    Button {
                        show3D = mgr.usdzURL
                    } label: {
                        Label("텍스처드 3D 보기 (회전·확대·AR)", systemImage: "rotate.3d").frame(maxWidth: .infinity)
                    }.buttonStyle(.borderedProminent).padding(.horizontal)
                }

                if !mgr.furnitureList.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("가구 (\(mgr.furnitureList.count))").font(.caption.bold()).foregroundStyle(.secondary)
                        ForEach(mgr.furnitureList) { f in
                            HStack {
                                Image(systemName: "cube.fill").font(.caption2).foregroundStyle(.blue)
                                Text(f.name).font(.subheadline)
                                Spacer()
                                Text(String(format: "%.0f×%.0f×%.0f cm", f.w * 100, f.d * 100, f.h * 100))
                                    .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                            }
                        }
                    }.padding(.horizontal)
                }

                Button {
                    up.uploadRoomPlan(usdz: mgr.usdzURL, roomJSON: roomJSON())
                } label: {
                    Label("맥으로 전송 (HTML 비교용)", systemImage: "desktopcomputer").frame(maxWidth: .infinity)
                }.buttonStyle(.bordered).padding(.horizontal)

                Button(action: mgr.rescan) {
                    Label("다시 스캔", systemImage: "arrow.clockwise").frame(maxWidth: .infinity)
                }.buttonStyle(.bordered).padding(.horizontal).padding(.bottom, 20)
            }
        }
    }

    private func stat(_ v: String, _ l: String) -> some View {
        VStack(spacing: 2) {
            Text(v).font(.subheadline.bold().monospacedDigit())
            Text(l).font(.caption2).foregroundStyle(.secondary)
        }
    }
}

/// 온디바이스 2D 평면도 — CapturedRoom 벽/문/창을 위에서 본 선으로 작도.
@available(iOS 17.0, *)
struct FloorPlan2D: View {
    @ObservedObject var mgr: RoomPlanSpikeManager
    var body: some View {
        // @MainActor 본문에서 값을 로컬로 읽어 Canvas(nonisolated) 클로저에 캡처.
        let walls = mgr.walls2D, doors = mgr.doors2D, windows = mgr.windows2D
        let pmin = mgr.planMin, psize = mgr.planSize
        Canvas { ctx, size in
            let pad: CGFloat = 24
            let s = min((size.width - 2 * pad) / max(psize.x, 0.1),
                        (size.height - 2 * pad) / max(psize.y, 0.1))
            let ox = (size.width - psize.x * s) / 2
            let oy = (size.height - psize.y * s) / 2
            func pt(_ p: CGPoint) -> CGPoint {
                CGPoint(x: ox + (p.x - pmin.x) * s, y: oy + (p.y - pmin.y) * s)
            }
            func draw(_ segs: [[CGPoint]], _ color: Color, _ width: CGFloat) {
                for seg in segs where seg.count == 2 {
                    var path = Path(); path.move(to: pt(seg[0])); path.addLine(to: pt(seg[1]))
                    ctx.stroke(path, with: .color(color), lineWidth: width)
                }
            }
            draw(walls, .primary, 6)      // 벽(두껍게)
            draw(windows, .blue, 4)       // 창(파랑)
            draw(doors, .green, 4)        // 문(초록)
        }
    }
}
