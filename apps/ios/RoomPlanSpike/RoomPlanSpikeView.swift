//  RoomPlanSpikeView.swift
//  MoveViz — RoomPlan 스파이크 화면 (트랙 A)
//
//  RoomCaptureView(frame:arSession:)로 라이브 코칭 프리뷰를 띄우고,
//  같은 ARSession 위에서 ARMeshAnchor를 동시 수집(매니저가 측정).
//  하단에 3가지 Go/No-Go 측정값을 실시간 표시한다.
//
//  Xcode 통합: 이 파일 + RoomPlanSpikeManager.swift 를 타깃에 추가하고,
//  앱 어딘가에서 RoomPlanSpikeScreen()을 present 하면 된다. (LiDAR 기기 필요)

import SwiftUI
import RoomPlan
import ARKit

// MARK: - RoomCaptureView 래퍼 (커스텀 ARSession 공유 + 전체 화각 레터박스)

@available(iOS 17.0, *)
struct RoomCaptureViewRepresentable: UIViewControllerRepresentable {
    let manager: RoomPlanSpikeManager

    func makeUIViewController(context: Context) -> RoomCaptureAspectController {
        let vc = RoomCaptureAspectController()
        vc.manager = manager
        return vc
    }

    func updateUIViewController(_ vc: RoomCaptureAspectController, context: Context) {}
}

/// RoomCaptureView를 화면에 꽉 채우면(aspect-fill) 4:3 카메라 영상의 가로 화각이
/// 세로 화면에서 ~38% 잘려 "줌된 것처럼" 보인다 → 카메라/LiDAR 탭과 동일하게
/// 영상 비율로 aspect-fit(레터박스)해 센서 전체 화각을 보여준다.
@available(iOS 17.0, *)
final class RoomCaptureAspectController: UIViewController {
    weak var manager: RoomPlanSpikeManager?
    private var captureView: RoomCaptureView?
    private var feedAspect: CGFloat = 3.0 / 4.0   // portrait w/h

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        guard let manager else { return }
        let v = RoomCaptureView(frame: .zero, arSession: manager.arSession)
        manager.bind(v.captureSession)   // captureSession 델리게이트 연결
        view.addSubview(v)
        captureView = v
        let res = ARWorldTrackingConfiguration().videoFormat.imageResolution
        if res.width > 0, res.height > 0 { feedAspect = res.height / res.width }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let b = view.bounds
        var w = b.width, h = b.width / feedAspect
        if h > b.height { h = b.height; w = b.height * feedAspect }
        captureView?.frame = CGRect(x: (b.width - w) / 2, y: (b.height - h) / 2,
                                    width: w, height: h)
    }

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .portrait }
}

// MARK: - 스파이크 화면

@available(iOS 17.0, *)
struct RoomPlanSpikeScreen: View {
    @StateObject private var mgr = RoomPlanSpikeManager()

    var body: some View {
        ZStack(alignment: .bottom) {
            RoomCaptureViewRepresentable(manager: mgr)
                .ignoresSafeArea()

            VStack(spacing: 10) {
                // 상태
                Text(mgr.status)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(.black.opacity(0.55), in: Capsule())

                // 측정 패널
                metrics
                    .padding(14)
                    .background(.black.opacity(0.62), in: RoundedRectangle(cornerRadius: 16))
                    .foregroundStyle(.white)

                // 컨트롤
                HStack(spacing: 12) {
                    if !mgr.isScanning {
                        Button(action: mgr.start) {
                            Label("Start", systemImage: "play.fill")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                    } else {
                        Button(role: .destructive, action: mgr.stop) {
                            Label("Stop & 처리", systemImage: "stop.fill")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                    }
                }
            }
            .padding(16)
        }
    }

    @ViewBuilder private var metrics: some View {
        VStack(alignment: .leading, spacing: 8) {
            // #1 동시 수집
            HStack {
                Text("① 동시수집").font(.caption.bold())
                Spacer()
                Text("\(mgr.bothFrames)/\(mgr.sampledFrames)  \(pct(mgr.coexistRatio))")
                    .font(.caption.monospacedDigit())
                Text(mgr.coexistRatio >= 0.9 ? "GO" : "—")
                    .font(.caption2.bold())
                    .foregroundStyle(mgr.coexistRatio >= 0.9 ? .green : .yellow)
            }
            Divider().overlay(.white.opacity(0.2))
            // #2 시맨틱
            HStack {
                Text("② 시맨틱").font(.caption.bold())
                Spacer()
                Text("벽\(mgr.wallCount) 문\(mgr.doorCount) 창\(mgr.windowCount) 개구\(mgr.openingCount) 가구\(mgr.objectCount)")
                    .font(.caption.monospacedDigit())
            }
            if !mgr.objectsByCategory.isEmpty {
                Text(mgr.objectsByCategory.sorted { $0.value > $1.value }
                        .map { "\($0.key)\($0.value)" }.joined(separator: " · "))
                    .font(.caption2).foregroundStyle(.white.opacity(0.85))
            }
            Divider().overlay(.white.opacity(0.2))
            // #3 치수
            HStack {
                Text("③ 치수").font(.caption.bold())
                Spacer()
                Text("바닥 \(String(format: "%.2f", mgr.floorAreaM2))㎡ · 벽 \(mgr.wallLengths.count)")
                    .font(.caption.monospacedDigit())
            }
            if !mgr.reportText.isEmpty {
                Text("📄 산출물 저장됨 (Documents): capturedroom.json / room.usdz / report.json")
                    .font(.caption2).foregroundStyle(.green)
            }
        }
    }

    private func pct(_ r: Double) -> String { String(format: "%.0f%%", r * 100) }
}

// 하위 호환: iOS17 미만에서는 안내
struct RoomPlanSpikeEntry: View {
    var body: some View {
        if #available(iOS 17.0, *) {
            RoomPlanSpikeScreen()
        } else {
            Text("RoomPlan 스파이크는 iOS 17+ / LiDAR 기기에서 동작합니다.")
                .multilineTextAlignment(.center).padding()
        }
    }
}
