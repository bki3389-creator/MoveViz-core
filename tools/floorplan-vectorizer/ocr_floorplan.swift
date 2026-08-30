// 평면도 이미지 OCR (Apple Vision) → JSON 토큰 출력
// usage: ocr_floorplan <image>  → stdout: {"w":W,"h":H,"tokens":[{"t":"침실","x":..,"y":..,"w":..,"h":..}]}
import Foundation
import Vision
import AppKit

guard CommandLine.arguments.count > 1,
      let img = NSImage(contentsOfFile: CommandLine.arguments[1]),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("이미지 로드 실패\n".data(using:.utf8)!); exit(1)
}
let W = cg.width, H = cg.height
var toks: [[String: Any]] = []
let sem = DispatchSemaphore(value: 0)
let req = VNRecognizeTextRequest { req, _ in
    if let obs = req.results as? [VNRecognizedTextObservation] {
        for o in obs {
            guard let c = o.topCandidates(1).first else { continue }
            let b = o.boundingBox  // normalized, origin bottom-left
            toks.append([
                "t": c.string,
                "x": Int(b.midX * Double(W)),
                "y": Int((1 - b.midY) * Double(H)),   // top-left 기준
                "w": Int(b.width * Double(W)),
                "h": Int(b.height * Double(H)),
                "conf": c.confidence
            ])
        }
    }
    sem.signal()
}
req.recognitionLevel = .accurate
req.recognitionLanguages = ["ko-KR", "en-US"]
req.usesLanguageCorrection = false
try? VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
sem.wait()
let out: [String: Any] = ["w": W, "h": H, "tokens": toks]
let data = try! JSONSerialization.data(withJSONObject: out, options: [])
FileHandle.standardOutput.write(data)
