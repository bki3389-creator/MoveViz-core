//  PhotogrammetryManager.swift
//  MoveViz — 비-LiDAR 폰 재구성 (Apple Object Capture / PhotogrammetrySession)
//
//  폴리캠의 "LiDAR 없는 폰" 모드 = 순수 포토그래메트리. Apple PhotogrammetrySession은
//  LiDAR가 "필수가 아니다"([검증] 사진 MVS 기반). 가이드 UI(ObjectCaptureSession)는 LiDAR가
//  필요하지만, 우리가 사진을 직접 모아(KeyframeRecorder) PhotogrammetrySession에 넣으면
//  LiDAR 없는 기기에서도 동작한다. 기기 가능 여부는 수치 하드코딩 금지 — isSupported만 신뢰.
//
//  출력 USDZ → (데스크톱) usdz_to_glb.py → 기존 glb_to_floorplan.py 파이프라인에 연결.
//
//  ⚠️ 스케일: 순수 SfM은 절대 스케일 모호. KeyframeRecorder가 ARKit 포즈(실측 baseline/gravity)를
//  함께 저장하므로, 후속으로 그 포즈로 스케일 앵커링한다(단안 뎁스 메트릭은 신뢰하지 않음).

import Foundation
import RealityKit
import Combine

@available(iOS 17.0, *)
@MainActor
final class PhotogrammetryManager: ObservableObject {

    @Published var status = "준비됨"
    @Published var progress: Double = 0
    @Published var isProcessing = false
    @Published var outputUSDZ = ""
    @Published var supported = PhotogrammetrySession.isSupported   // 런타임 게이트(수치 하드코딩 X)

    private var task: Task<Void, Never>?

    /// 사진 폴더(KeyframeRecorder.sessionDir 또는 Object Capture 이미지셋) → USDZ 재구성.
    func reconstruct(from imagesFolder: URL, detail: PhotogrammetrySession.Request.Detail = .reduced) {
        guard PhotogrammetrySession.isSupported else {
            status = "⚠️ 이 기기는 Object Capture(PhotogrammetrySession)를 지원하지 않습니다."
            return
        }
        guard !isProcessing else { return }
        isProcessing = true; progress = 0; outputUSDZ = ""
        status = "포토그래메트리 처리 중… (사진 → 3D)"

        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let outURL = docs.appendingPathComponent("nonlidar_model.usdz")

        task = Task { [weak self] in
            guard let self else { return }
            do {
                var config = PhotogrammetrySession.Configuration()
                config.featureSensitivity = .high           // 텍스처 적은 실내 보강
                config.sampleOrdering = .sequential          // 키프레임이 시간순
                let session = try PhotogrammetrySession(input: imagesFolder, configuration: config)
                let request = PhotogrammetrySession.Request.modelFile(url: outURL, detail: detail)

                try session.process(requests: [request])

                for try await output in session.outputs {
                    switch output {
                    case .requestProgress(_, let fraction):
                        await MainActor.run { self.progress = fraction }
                    case .requestComplete(_, let result):
                        if case .modelFile(let url) = result {
                            await MainActor.run { self.outputUSDZ = url.path }
                        }
                    case .processingComplete:
                        await MainActor.run {
                            self.status = "✅ 완료 — USDZ 저장됨. 데스크톱에서 usdz_to_glb.py로 변환 → 평면도 파이프라인."
                            self.isProcessing = false; self.progress = 1
                        }
                        return
                    case .requestError(_, let error):
                        await MainActor.run {
                            self.status = "처리 오류: \(error.localizedDescription)"; self.isProcessing = false
                        }
                        return
                    case .processingCancelled:
                        await MainActor.run { self.status = "취소됨"; self.isProcessing = false }
                        return
                    default:
                        break
                    }
                }
            } catch {
                await MainActor.run {
                    self.status = "세션 생성 실패: \(error.localizedDescription)"; self.isProcessing = false
                }
            }
        }
    }

    func cancel() {
        task?.cancel(); task = nil
        isProcessing = false; status = "취소됨"
    }
}
