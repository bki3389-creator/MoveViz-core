//  MeshExporter.swift
//  MoveViz — ARMeshAnchor(면 포함) → OBJ 메시 export.
//
//  기존 PLYExporter는 점군(점만)이라 평면도 파이프라인(면 normal 필요)에 못 쓴다.
//  이 누적기는 anchor별 최신 정점+면을 보관해 OBJ(v/f)로 내보낸다 → 맥 ingest 서버로 업로드.

import ARKit
import simd

final class MeshAccumulator: @unchecked Sendable {
    private let lock = NSLock()
    private var store: [UUID: (v: [SIMD3<Float>], f: [UInt32])] = [:]
    private var lastCopy: [UUID: TimeInterval] = [:]

    /// anchor의 월드 정점 + 면 인덱스를 갱신(같은 anchor는 교체).
    /// ARKit은 같은 anchor를 초당 수차례 갱신하는데 매번 전체 버퍼를 복사하면
    /// 스캔이 커질수록 비용이 제곱으로 늘어 렉 유발 → anchor별 0.7s 스로틀.
    /// (마지막 갱신 손실은 refine 수준이라 무시 가능; stop 직전 상태로 export됨)
    func update(_ anchor: ARMeshAnchor, force: Bool = false) {
        let now = CACurrentMediaTime()
        lock.lock()
        let last = lastCopy[anchor.identifier] ?? 0
        if !force, now - last < 0.7 { lock.unlock(); return }
        lastCopy[anchor.identifier] = now
        lock.unlock()
        let g = anchor.geometry
        // 정점(월드 변환)
        let vt = g.vertices
        var verts = [SIMD3<Float>](); verts.reserveCapacity(vt.count)
        let vptr = vt.buffer.contents()
        for i in 0..<vt.count {
            let p = vptr.advanced(by: vt.offset + vt.stride * i)
            let x = p.load(as: Float.self)
            let y = p.advanced(by: 4).load(as: Float.self)
            let z = p.advanced(by: 8).load(as: Float.self)
            let w = anchor.transform * SIMD4<Float>(x, y, z, 1)
            verts.append(SIMD3<Float>(w.x, w.y, w.z))
        }
        // 면(삼각형 인덱스)
        let fe = g.faces
        let perPrim = fe.indexCountPerPrimitive            // 3
        let total = fe.count * perPrim
        var faces = [UInt32](); faces.reserveCapacity(total)
        let fptr = fe.buffer.contents()
        let bpi = fe.bytesPerIndex
        for i in 0..<total {
            let p = fptr.advanced(by: i * bpi)
            let idx: UInt32 = (bpi == 2) ? UInt32(p.load(as: UInt16.self)) : p.load(as: UInt32.self)
            faces.append(idx)
        }
        lock.lock(); store[anchor.identifier] = (verts, faces); lock.unlock()
    }

    func reset() { lock.lock(); store.removeAll(); lastCopy.removeAll(); lock.unlock() }

    var faceCount: Int { lock.lock(); defer { lock.unlock() }; return store.values.reduce(0) { $0 + $1.f.count / 3 } }
    var vertexCount: Int { lock.lock(); defer { lock.unlock() }; return store.values.reduce(0) { $0 + $1.v.count } }

    /// OBJ로 저장(정점 v + 삼각형 f, 1-based, anchor별 offset 누적).
    /// 대형 스캔에서 통짜 문자열은 수십초 멈춤+메모리 폭발 → anchor 단위로
    /// 스트리밍 쓰기. 백그라운드 스레드에서 호출해도 안전.
    func writeOBJ(to url: URL) -> Bool {
        lock.lock(); let snap = store; lock.unlock()
        FileManager.default.createFile(atPath: url.path, contents: nil)
        guard let fh = try? FileHandle(forWritingTo: url) else { return false }
        defer { try? fh.close() }
        do {
            try fh.write(contentsOf: Data("# MoveViz LiDAR mesh\n".utf8))
            var off: UInt32 = 0
            for (_, m) in snap {
                var chunk = String(); chunk.reserveCapacity(m.v.count * 24)
                for v in m.v { chunk += "v \(v.x) \(v.y) \(v.z)\n" }
                var i = 0
                while i + 2 < m.f.count {
                    chunk += "f \(m.f[i] + 1 + off) \(m.f[i+1] + 1 + off) \(m.f[i+2] + 1 + off)\n"
                    i += 3
                }
                try fh.write(contentsOf: Data(chunk.utf8))
                off += UInt32(m.v.count)
            }
            return true
        } catch { print("OBJ write failed: \(error)"); return false }
    }

    /// temp에 OBJ 저장하고 URL 반환. 파일명에 타임스탬프 — 업로드 중인 파일을
    /// 다음 export가 덮어쓰는 경쟁 방지.
    func exportOBJ(name: String = "moveviz_mesh") -> URL? {
        let stamp = Int(Date().timeIntervalSince1970)
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(name)_\(stamp).obj")
        return writeOBJ(to: url) ? url : nil
    }
}
