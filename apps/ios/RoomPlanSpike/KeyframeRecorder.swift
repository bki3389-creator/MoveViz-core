//  KeyframeRecorder.swift
//  MoveViz — 텍스처링 + 비-LiDAR 포토그래메트리 공통 입력 캡처
//
//  현재 우리 스캔은 카메라 transform만 캡처하고(ScanManager:252) RGB·intrinsics는 안 모은다.
//  이 컴포넌트는 ARFrame에서 키프레임(RGB JPEG + intrinsics K + camera transform + 해상도)을
//  디스크에 저장한다. 산출물 `poses.json`은 데스크톱 `colorize_vertices.py`(정점 색칠)와
//  Apple Object Capture(PhotogrammetrySession)의 입력으로 그대로 쓰인다.
//
//  비침습: 기존 ScanManager를 수정하지 않고, ARSessionDelegate를 가진 쪽에서
//  record(frame:)을 매 프레임 호출하면 내부에서 throttle(이동/회전/간격)한다.

import Foundation
import ARKit
import CoreImage
import simd

@available(iOS 16.0, *)
final class KeyframeRecorder {

    struct Keyframe: Codable {
        let image: String                 // 파일명 (folder 상대)
        let K: [[Double]]                 // 3x3 intrinsics (imageResolution 기준)
        let cam_to_world: [[Double]]      // 4x4 (ARKit world)
        let imageResolution: [Int]        // [width, height] (capturedImage 네이티브)
        let convention: String            // "arkit" — 데스크톱이 OpenCV로 변환
    }

    let sessionDir: URL
    private(set) var frames: [Keyframe] = []
    private let ci = CIContext(options: [.useSoftwareRenderer: false])

    // throttle 파라미터
    private let minTranslation: Float       // m
    private let minRotation: Float          // rad
    private let maxFrames: Int
    private var lastPos: SIMD3<Float>?
    private var lastYawPitch: SIMD2<Float>?
    private var saved = 0

    init(name: String = "keyframes",
         minTranslation: Float = 0.15, minRotation: Float = 0.20, maxFrames: Int = 120) {
        self.minTranslation = minTranslation
        self.minRotation = minRotation
        self.maxFrames = maxFrames
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        sessionDir = docs.appendingPathComponent(name, isDirectory: true)
        try? FileManager.default.createDirectory(at: sessionDir, withIntermediateDirectories: true)
    }

    var count: Int { saved }

    /// 매 프레임 호출. 충분히 이동/회전했을 때만 키프레임 저장.
    @discardableResult
    func record(_ frame: ARFrame) -> Bool {
        guard saved < maxFrames else { return false }
        let t = frame.camera.transform
        let pos = SIMD3<Float>(t.columns.3.x, t.columns.3.y, t.columns.3.z)
        let euler = frame.camera.eulerAngles            // (pitch, yaw, roll)
        let yp = SIMD2<Float>(euler.x, euler.y)

        if let lp = lastPos, let ly = lastYawPitch {
            let moved = simd_distance(pos, lp)
            let rotated = max(abs(yp.x - ly.x), abs(yp.y - ly.y))
            if moved < minTranslation && rotated < minRotation { return false }
        }

        guard let (jpeg, s) = jpegData(from: frame.capturedImage) else { return false }
        let name = String(format: "kf_%04d.jpg", saved)
        do {
            try jpeg.write(to: sessionDir.appendingPathComponent(name))
        } catch { return false }

        let k = frame.camera.intrinsics                  // 3x3 (네이티브 해상도 기준)
        let res = frame.camera.imageResolution
        // 이미지를 s배 축소했으므로 K(fx,fy,cx,cy)와 해상도도 s배로 맞춘다(투영 일치).
        frames.append(Keyframe(
            image: name,
            K: scaleK(mat3(k), Double(s)),
            cam_to_world: mat4(t),
            imageResolution: [Int(res.width * CGFloat(s)), Int(res.height * CGFloat(s))],
            convention: "arkit"
        ))
        lastPos = pos; lastYawPitch = yp; saved += 1
        return true
    }

    /// poses.json 저장 → 데스크톱/Object Capture 입력 폴더 완성. 폴더 URL 반환.
    @discardableResult
    func finish() -> URL? {
        do {
            let enc = JSONEncoder(); enc.outputFormatting = [.prettyPrinted]
            let data = try enc.encode(frames)
            try data.write(to: sessionDir.appendingPathComponent("poses.json"))
            return sessionDir
        } catch { return nil }
    }

    func reset() {
        frames.removeAll(); saved = 0; lastPos = nil; lastYawPitch = nil
        try? FileManager.default.removeItem(at: sessionDir)
        try? FileManager.default.createDirectory(at: sessionDir, withIntermediateDirectories: true)
    }

    // MARK: - Helpers

    // 긴 변 최대 픽셀. 업로드 용량 ↓(풀해상도 대비 ~4배) + OWLv2도 어차피 960px로 리사이즈.
    private let maxDim: CGFloat = 1024

    /// (JPEG, 적용된 축소비율 s). s<1이면 축소됨 → K·해상도에 반영해야 함.
    private func jpegData(from pixelBuffer: CVPixelBuffer) -> (Data, CGFloat)? {
        // ARKit capturedImage(YCbCr) → CIImage가 RGB로 처리. 네이티브(landscape) 방향 유지
        // (intrinsics가 그 방향 기준이므로 회전하지 않는다).
        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        let longest = max(ciImage.extent.width, ciImage.extent.height)
        let s = longest > 0 ? min(1, maxDim / longest) : 1
        let img = s < 1 ? ciImage.transformed(by: CGAffineTransform(scaleX: s, y: s)) : ciImage
        guard let cg = ci.createCGImage(img, from: img.extent) else { return nil }
        #if canImport(UIKit)
        let data = UIImage(cgImage: cg).jpegData(compressionQuality: 0.8) ?? Data()
        return (data, s)
        #else
        return nil
        #endif
    }

    /// 이미지 s배 축소에 맞춰 K 스케일: fx,fy,cx,cy ×s (마지막 행은 [0,0,1] 유지).
    private func scaleK(_ k: [[Double]], _ s: Double) -> [[Double]] {
        [[k[0][0] * s, k[0][1] * s, k[0][2] * s],
         [k[1][0] * s, k[1][1] * s, k[1][2] * s],
         [0, 0, 1]]
    }

    private func mat3(_ m: simd_float3x3) -> [[Double]] {
        // column-major simd → row-major [[r]] (K는 대칭상 영향 없지만 명시 변환)
        (0..<3).map { r in (0..<3).map { c in Double(m[c][r]) } }
    }
    private func mat4(_ m: simd_float4x4) -> [[Double]] {
        (0..<4).map { r in (0..<4).map { c in Double(m[c][r]) } }
    }
}

#if canImport(UIKit)
import UIKit
#endif
