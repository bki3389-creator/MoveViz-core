//  ModelViewer.swift
//  MoveViz — 폰에서 3D 메시(OBJ/USDZ) 보기.
//  ※ iOS QuickLook의 3D 프리뷰는 USDZ 전용이라 ARKit OBJ는 거의 안 열림 → SceneKit으로 렌더.
//    SceneKit(Model I/O)은 OBJ를 안정적으로 로드. 법선 생성 + 카메라 프레이밍 + 회전/확대.

import SwiftUI
import SceneKit
import ModelIO
import SceneKit.ModelIO
import QuickLook

// .sheet(item:)용 — URL을 Identifiable로
extension URL: @retroactive Identifiable {
    public var id: String { absoluteString }
}

/// USDZ 전용 QuickLook(텍스처/displayColor를 RealityKit이 제대로 렌더 + AR).
struct QuickLookViewer: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> QLPreviewController {
        let c = QLPreviewController(); c.dataSource = context.coordinator; return c
    }
    func updateUIViewController(_ c: QLPreviewController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(url: url) }
    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        let url: URL
        init(url: URL) { self.url = url }
        func numberOfPreviewItems(in c: QLPreviewController) -> Int { 1 }
        func previewController(_ c: QLPreviewController, previewItemAt i: Int) -> QLPreviewItem { url as QLPreviewItem }
    }
}

struct ModelViewer: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> SCNView {
        let v = SCNView()
        v.allowsCameraControl = true            // 드래그 회전 / 핀치 확대
        v.autoenablesDefaultLighting = true
        v.backgroundColor = .black
        v.antialiasingMode = .multisampling4X
        if let scene = Self.loadScene(url) {
            v.scene = scene
            v.pointOfView = scene.rootNode.childNode(withName: "previewCam", recursively: false)
        }
        return v
    }

    func updateUIView(_ v: SCNView, context: Context) {}

    /// OBJ/USDZ → SCNScene. ARKit OBJ엔 법선이 없어 조명이 안 먹으므로 생성.
    static func loadScene(_ url: URL) -> SCNScene? {
        let asset = MDLAsset(url: url)
        guard asset.count > 0 else { return nil }
        for i in 0..<asset.count {
            if let mesh = asset.object(at: i) as? MDLMesh {
                mesh.addNormals(withAttributeNamed: MDLVertexAttributeNormal, creaseThreshold: 0.5)
            }
        }
        let scene = SCNScene(mdlAsset: asset)

        // 바운딩박스로 카메라 자동 프레이밍
        let bb = asset.boundingBox
        let mn = bb.minBounds, mx = bb.maxBounds
        let cx = (mn.x + mx.x) / 2, cy = (mn.y + mx.y) / 2, cz = (mn.z + mx.z) / 2
        let ext = max(mx.x - mn.x, max(mx.y - mn.y, mx.z - mn.z))
        let dist = (ext == 0 ? 1 : ext) * 1.8

        let target = SCNNode(); target.position = SCNVector3(cx, cy, cz)
        scene.rootNode.addChildNode(target)

        let cam = SCNNode(); cam.name = "previewCam"; cam.camera = SCNCamera()
        cam.camera?.zNear = 0.001
        cam.camera?.zFar = Double((ext + dist) * 4 + 10)
        cam.position = SCNVector3(cx, cy + ext * 0.25, cz + dist)
        cam.constraints = [SCNLookAtConstraint(target: target)]
        scene.rootNode.addChildNode(cam)
        return scene
    }
}

/// 시트로 띄우는 래퍼 — 확장자로 뷰어 선택: USDZ→QuickLook(텍스처), OBJ/PLY→SceneKit.
struct ModelViewerSheet: View {
    let url: URL
    @Environment(\.dismiss) private var dismiss
    private var isUSD: Bool {
        ["usdz", "usdc", "usd", "usda"].contains(url.pathExtension.lowercased())
    }
    var body: some View {
        NavigationStack {
            Group {
                if isUSD {
                    QuickLookViewer(url: url).ignoresSafeArea()
                } else if ModelViewer.loadScene(url) != nil {
                    ModelViewer(url: url).ignoresSafeArea()
                } else {
                    VStack(spacing: 10) {
                        Image(systemName: "cube.transparent").font(.largeTitle).foregroundStyle(.secondary)
                        Text("메시를 불러올 수 없습니다").foregroundStyle(.secondary)
                        Text(url.lastPathComponent).font(.caption2).foregroundStyle(.tertiary)
                    }
                }
            }
            .navigationTitle(isUSD ? "텍스처드 3D" : "3D 메시")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("닫기") { dismiss() } } }
        }
    }
}
