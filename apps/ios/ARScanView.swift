import SwiftUI
import RealityKit
import ARKit

/// ARView를 UIViewController로 호스팅 — SwiftUI UIViewRepresentable 단독은
/// 방향(orientation) 업데이트를 못 받아 카메라가 옆으로 누워 보이는 문제가 있음.
/// UIViewController가 회전/레이아웃 시스템에 참여해 카메라 프리뷰 방향을 바로잡는다.
struct ARScanView: UIViewControllerRepresentable {
    let scanManager: ScanManager

    func makeUIViewController(context: Context) -> ARViewController {
        let vc = ARViewController()
        vc.scanManager = scanManager
        return vc
    }

    func updateUIViewController(_ uiViewController: ARViewController, context: Context) {}
}

final class ARViewController: UIViewController {
    weak var scanManager: ScanManager?
    let arView = ARView(frame: .zero)
    // 카메라 영상 표시 비율(portrait, w/h). 기본 4:3 → 0.75. 세션 비디오포맷에서 실측.
    private var feedAspect: CGFloat = 3.0 / 4.0

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        arView.renderOptions = [.disablePersonOcclusion, .disableMotionBlur]
        view.addSubview(arView)
        let res = ARWorldTrackingConfiguration().videoFormat.imageResolution  // 가로(landscape) 기준
        if res.width > 0, res.height > 0 { feedAspect = res.height / res.width }
        scanManager?.configure(arView)
    }

    // 카메라 영상을 '안 자르고' 전체 화각으로 보이게 — 화면에 영상 비율로 aspect-fit(레터박스).
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let b = view.bounds
        var w = b.width, h = b.width / feedAspect
        if h > b.height { h = b.height; w = b.height * feedAspect }
        arView.frame = CGRect(x: (b.width - w) / 2, y: (b.height - h) / 2, width: w, height: h)
    }

    // 이 탭이 보일 때만 세션 실행 — 두 탭의 ARSession이 동시에 카메라를 다투면
    // 방향이 틀어지므로, 사라질 때 pause / 나타날 때 resume 한다.
    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        if scanManager?.phase != .scanning {
            let cfg = ARWorldTrackingConfiguration()
            if ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh) {
                cfg.sceneReconstruction = .mesh   // 프리뷰에서 메시 오버레이
            }
            arView.session.run(cfg, options: [.resetTracking, .removeExistingAnchors])
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        arView.session.pause()
    }

    // 포트레이트 고정(카메라 프리뷰와 UI 방향 일치)
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .portrait }
    override var preferredInterfaceOrientationForPresentation: UIInterfaceOrientation { .portrait }
}
