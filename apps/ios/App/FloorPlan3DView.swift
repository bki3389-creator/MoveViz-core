//  FloorPlan3DView.swift
//  MoveViz — plan.json을 입체 평면도로: 바닥 + 벽 입면 + 가구 박스 (SceneKit).
//  드래그 회전 / 핀치 확대. 2D FloorPlanView와 같은 데이터를 쓴다.

import SceneKit
import SwiftUI

struct FloorPlan3DView: UIViewRepresentable {
    let plan: PlanData

    func makeUIView(context: Context) -> SCNView {
        let v = SCNView()
        v.allowsCameraControl = true
        v.autoenablesDefaultLighting = true
        v.backgroundColor = UIColor.systemBackground
        v.antialiasingMode = .multisampling4X
        v.scene = Self.buildScene(plan)
        return v
    }

    func updateUIView(_ v: SCNView, context: Context) {}

    static func buildScene(_ plan: PlanData) -> SCNScene {
        let scene = SCNScene()
        let root = scene.rootNode
        guard let b = plan.bounds else { return scene }
        let wallH = CGFloat(max(2.2, min(3.5, (plan.ceil_y ?? 2.4) - (plan.floor_y ?? 0))))
        let cx = b.midX, cz = b.midY   // 씬 중앙 정렬용

        func node(box w: CGFloat, _ h: CGFloat, _ d: CGFloat,
                  at x: CGFloat, _ y: CGFloat, _ z: CGFloat,
                  color: UIColor, alpha: CGFloat = 1) -> SCNNode {
            let g = SCNBox(width: max(w, 0.02), height: h, length: max(d, 0.02),
                           chamferRadius: 0)
            g.firstMaterial?.diffuse.contents = color.withAlphaComponent(alpha)
            g.firstMaterial?.isDoubleSided = true
            let n = SCNNode(geometry: g)
            n.position = SCNVector3(x - cx, y, z - cz)
            return n
        }

        // 바닥: 방 폴리곤(있으면) 또는 경계 bbox
        let floorSrc = (plan.rooms ?? []).compactMap { $0.polygon }
        let polys = floorSrc.isEmpty ? [plan.boundary ?? []] : floorSrc
        for poly in polys where poly.count >= 3 {
            let path = UIBezierPath()
            path.move(to: CGPoint(x: poly[0][0], y: poly[0][1]))
            for p in poly.dropFirst() where p.count >= 2 {
                path.addLine(to: CGPoint(x: p[0], y: p[1]))
            }
            path.close()
            let shape = SCNShape(path: path, extrusionDepth: 0.05)
            shape.firstMaterial?.diffuse.contents = UIColor.systemGray5
            let n = SCNNode(geometry: shape)
            // XY 평면의 shape → 바닥(XZ)으로 눕히기
            n.eulerAngles.x = .pi / 2
            n.position = SCNVector3(-cx, -0.025, -cz)
            root.addChildNode(n)
        }

        // 외곽 경계 벽 (Manhattan 폴리곤 에지)
        if let bd = plan.boundary, bd.count >= 2 {
            let closed = bd + [bd[0]]
            for i in 0..<(closed.count - 1) {
                let a = closed[i], c = closed[i + 1]
                guard a.count >= 2, c.count >= 2 else { continue }
                root.addChildNode(node(box: CGFloat(abs(c[0] - a[0])) + 0.12, wallH,
                                       CGFloat(abs(c[1] - a[1])) + 0.12,
                                       at: CGFloat(a[0] + c[0]) / 2, wallH / 2,
                                       CGFloat(a[1] + c[1]) / 2,
                                       color: .systemGray2, alpha: 0.85))
            }
        }

        // 내부 벽 (xw: x=pos 세로벽 / zw: z=pos 가로벽)
        for w in plan.xw ?? [] {
            guard let x = w.pos else { continue }
            for s in w.segs ?? [] where s.count >= 2 {
                root.addChildNode(node(box: 0.08, wallH, CGFloat(abs(s[1] - s[0])),
                                       at: CGFloat(x), wallH / 2, CGFloat(s[0] + s[1]) / 2,
                                       color: .systemGray3, alpha: 0.8))
            }
        }
        for w in plan.zw ?? [] {
            guard let z = w.pos else { continue }
            for s in w.segs ?? [] where s.count >= 2 {
                root.addChildNode(node(box: CGFloat(abs(s[1] - s[0])), wallH, 0.08,
                                       at: CGFloat(s[0] + s[1]) / 2, wallH / 2, CGFloat(z),
                                       color: .systemGray3, alpha: 0.8))
            }
        }

        // 가구: 회전 OBB를 눌러올린 프리즘
        for f in plan.furniture ?? [] {
            let corners = f.corners
            guard corners.count >= 3 else { continue }
            let path = UIBezierPath()
            path.move(to: CGPoint(x: corners[0][0], y: corners[0][1]))
            for p in corners.dropFirst() where p.count >= 2 {
                path.addLine(to: CGPoint(x: p[0], y: p[1]))
            }
            path.close()
            let h: CGFloat = ["bed": 0.5, "sofa": 0.8, "table": 0.72, "desk": 0.72,
                             "chair": 0.9, "toilet": 0.75, "sink": 0.85, "bathtub": 0.55,
                             "refrigerator": 1.7, "cabinet": 1.2, "tv": 1.1][f.category ?? ""] ?? 0.75
            let shape = SCNShape(path: path, extrusionDepth: h)
            shape.firstMaterial?.diffuse.contents = UIColor.systemTeal.withAlphaComponent(0.75)
            let n = SCNNode(geometry: shape)
            n.eulerAngles.x = .pi / 2
            n.position = SCNVector3(-cx, h / 2, -cz)
            root.addChildNode(n)
        }

        // 카메라: 아이소메트릭 초기 시점
        let span = max(b.width, b.height)
        let cam = SCNNode()
        cam.camera = SCNCamera()
        cam.camera?.zFar = Double(span * 10 + 20)
        cam.position = SCNVector3(0, span * 0.9, span * 1.1)
        cam.look(at: SCNVector3(0, 0, 0))
        root.addChildNode(cam)
        return scene
    }
}
