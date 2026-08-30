//  CameraOnlyScanView.swift
//  MoveViz — 카메라 전용(비-LiDAR) 모드
//
//  LiDAR 없이 카메라만으로: ARWorldTrackingConfiguration(모든 ARKit 기기)로 프리뷰 + 포즈,
//  KeyframeRecorder가 RGB+intrinsics+포즈 키프레임을 저장(= 텍스처/포토그래메트리 공통 입력),
//  Stop 후 PhotogrammetrySession으로 사진 → USDZ 재구성.
//  → 데스크톱에서 usdz_to_glb.py → 기존 평면도 파이프라인.

import SwiftUI
import ARKit
import RealityKit

@available(iOS 17.0, *)
struct CameraOnlyScanView: View {
    var uploader: ScanUploader? = nil
    @StateObject private var photo = PhotogrammetryManager()
    @StateObject private var capture = CaptureCoordinator()
    @State private var showModel = false
    @State private var lastSaveID: String?   // '내 스캔' 저장 id — 결과(텍스처) 귀속용

    var body: some View {
        ZStack(alignment: .bottom) {
            ARPreview(coordinator: capture).ignoresSafeArea()

            VStack(spacing: 12) {
                // 상태/카운트
                VStack(spacing: 6) {
                    Text(photo.isProcessing ? photo.status
                         : (capture.isCapturing ? "촬영 중 — 천천히 대상 주위를 한 바퀴" : "카메라 전용 (비-LiDAR)"))
                        .font(.footnote.weight(.semibold))
                    HStack(spacing: 16) {
                        Label("\(capture.keyframes) 장", systemImage: "photo.stack")
                        if photo.isProcessing {
                            Label("\(Int(photo.progress*100))%", systemImage: "gearshape.2")
                        }
                    }.font(.caption.monospacedDigit())
                    if !photo.supported {
                        Text("⚠️ 이 기기는 Object Capture 미지원 — 키프레임은 모으지만 온디바이스 재구성은 불가(데스크톱에서 처리)")
                            .font(.caption2).foregroundStyle(.orange).multilineTextAlignment(.center)
                    }
                    // 맥으로 전송 — 재구성된 USDZ가 있으면 그걸로(→평면도), 없으면 이미지로(→궤적/콘택트시트)
                    if capture.keyframes > 0, let up = uploader {
                        Button {
                            if !photo.outputUSDZ.isEmpty {
                                up.upload(mesh: URL(fileURLWithPath: photo.outputUSDZ),
                                          mode: "camera", linkID: lastSaveID)
                            } else {
                                up.uploadKeyframes(folder: capture.recorder.sessionDir,
                                                   linkID: lastSaveID)
                            }
                        } label: {
                            Label(photo.outputUSDZ.isEmpty ? "맥으로 전송 (이미지 \(capture.keyframes)장)" : "맥으로 전송 → 평면도",
                                  systemImage: "desktopcomputer")
                        }.buttonStyle(.borderedProminent).controlSize(.small)
                    }
                    // 텍스처드 3D 메시 보기(폴리캠식 QuickLook) — Object Capture 결과
                    if !photo.outputUSDZ.isEmpty {
                        Text("✅ 3D 모델 생성됨").font(.caption2).foregroundStyle(.green)
                        Button {
                            showModel = true
                        } label: {
                            Label("3D 모델 보기 (텍스처)", systemImage: "view.3d")
                        }.buttonStyle(.bordered).controlSize(.small)
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity)
                .background(.black.opacity(0.6), in: RoundedRectangle(cornerRadius: 14))
                .foregroundStyle(.white)

                // 컨트롤
                HStack(spacing: 12) {
                    if !capture.isCapturing {
                        Button { capture.start() } label: {
                            Label("촬영 시작", systemImage: "record.circle").frame(maxWidth: .infinity)
                        }.buttonStyle(.borderedProminent).disabled(photo.isProcessing)
                    } else {
                        Button(role: .destructive) {
                            capture.stop()
                            // 업로드 실패해도 안 날아가게 '내 스캔'에 즉시 영구 저장
                            if capture.keyframes > 0 {
                                lastSaveID = ScanStore.shared.save(
                                    meshURL: nil,
                                    keyframesFolder: capture.recorder.sessionDir,
                                    vertexCount: 0)
                            }
                        } label: {
                            Label("촬영 종료", systemImage: "stop.circle").frame(maxWidth: .infinity)
                        }.buttonStyle(.borderedProminent)
                    }
                    Button {
                        if let folder = capture.finishAndFolder() {
                            photo.reconstruct(from: folder)
                        }
                    } label: {
                        Label("3D 재구성", systemImage: "cube.transparent").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .disabled(capture.isCapturing || capture.keyframes < 10 || photo.isProcessing)
                }
            }
            .padding(16)
        }
        .navigationTitle("카메라 전용")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showModel) {
            if !photo.outputUSDZ.isEmpty {
                ModelViewerSheet(url: URL(fileURLWithPath: photo.outputUSDZ))
            }
        }
    }
}

// MARK: - 캡처 코디네이터 (ARSession 프레임 → KeyframeRecorder)

@available(iOS 16.0, *)
final class CaptureCoordinator: NSObject, ObservableObject {
    @Published var isCapturing = false
    @Published var keyframes = 0

    let recorder = KeyframeRecorder(name: "camera_only", minTranslation: 0.07, minRotation: 0.10, maxFrames: 180)
    weak var session: ARSession?
    private var timer: Timer?

    /// "촬영 시작" → 0.3s 타이머로 자동 캡처(움직이면 키프레임 누적). updateUIView 의존 제거.
    func start() {
        recorder.reset(); keyframes = 0; isCapturing = true
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { [weak self] _ in
            self?.capture()
        }
    }
    func stop() {
        isCapturing = false
        timer?.invalidate(); timer = nil
        // poses.json 저장 — 이것 없이 이미지만 업로드하면 서버가 스케일/정합 불가.
        _ = recorder.finish()
    }

    deinit { timer?.invalidate() }   // 뷰 dismiss 시 반복 타이머 누수 방지

    private func capture() {
        guard isCapturing, let frame = session?.currentFrame else { return }
        if recorder.record(frame) { keyframes = recorder.count }   // record가 모션 throttle
    }

    /// poses.json 저장 후 입력 폴더 반환(재구성 버튼용).
    func finishAndFolder() -> URL? { recorder.finish() }
}

// MARK: - AR 프리뷰 — UIViewController 호스팅(카메라 방향 정상화)

@available(iOS 17.0, *)
struct ARPreview: UIViewControllerRepresentable {
    let coordinator: CaptureCoordinator

    func makeUIViewController(context: Context) -> CamPreviewController {
        let vc = CamPreviewController()
        vc.coordinator = coordinator
        return vc
    }
    func updateUIViewController(_ vc: CamPreviewController, context: Context) {}
}

@available(iOS 17.0, *)
final class CamPreviewController: UIViewController {
    weak var coordinator: CaptureCoordinator?
    let arView = ARView(frame: .zero, cameraMode: .ar, automaticallyConfigureSession: false)
    private var feedAspect: CGFloat = 3.0 / 4.0   // 카메라 영상 비율(portrait w/h)

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        view.addSubview(arView)
        let res = ARWorldTrackingConfiguration().videoFormat.imageResolution
        if res.width > 0, res.height > 0 { feedAspect = res.height / res.width }
    }

    // 전체 화각 레터박스(좌우 안 잘림): 화면에 영상 비율로 aspect-fit, 가운데 정렬.
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let b = view.bounds
        var w = b.width, h = b.width / feedAspect
        if h > b.height { h = b.height; w = b.height * feedAspect }
        arView.frame = CGRect(x: (b.width - w) / 2, y: (b.height - h) / 2, width: w, height: h)
    }

    // 보이는 탭의 세션만 실행 — 두 탭이 동시에 ARSession을 띄우면 방향이 충돌하므로
    // 나타날 때 run / 사라질 때 pause.
    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        let cfg = ARWorldTrackingConfiguration()   // LiDAR 불필요
        cfg.worldAlignment = .gravity
        coordinator?.session = arView.session
        arView.session.run(cfg)
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        arView.session.pause()
    }

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .portrait }
}
