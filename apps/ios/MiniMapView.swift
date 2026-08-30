import SwiftUI

/// Top-down coverage heatmap mini-map
struct MiniMapView: View {
    let gridData: [GridCell: Int]
    let minX: Int, maxX: Int, minY: Int, maxY: Int
    let cameraX: Float
    let cameraZ: Float
    let cameraYaw: Float
    let gridRes: Float

    private let mapSize: CGFloat = 160

    var body: some View {
        Canvas { context, size in
            let gridW = maxX - minX + 1
            let gridH = maxY - minY + 1
            guard gridW > 0, gridH > 0 else { return }

            let cellW = size.width / CGFloat(gridW)
            let cellH = size.height / CGFloat(gridH)
            let cellSize = min(cellW, cellH)

            // Center the grid in the canvas
            let totalW = cellSize * CGFloat(gridW)
            let totalH = cellSize * CGFloat(gridH)
            let offsetX = (size.width - totalW) / 2
            let offsetY = (size.height - totalH) / 2

            // Find max density for normalization
            let maxDensity = max(1, gridData.values.max() ?? 1)

            // Draw scanned cells
            for (cell, count) in gridData {
                let x = offsetX + CGFloat(cell.x - minX) * cellSize
                let y = offsetY + CGFloat(cell.y - minY) * cellSize
                let intensity = min(1.0, CGFloat(count) / CGFloat(maxDensity) * 1.5)

                // Color: dark teal → bright cyan based on density
                let color = Color(
                    red: 0.05 + 0.15 * intensity,
                    green: 0.25 + 0.55 * intensity,
                    blue: 0.35 + 0.55 * intensity
                )
                context.fill(
                    Path(CGRect(x: x, y: y, width: cellSize + 0.5, height: cellSize + 0.5)),
                    with: .color(color)
                )
            }

            // Draw bounding box outline
            let boundRect = CGRect(x: offsetX, y: offsetY, width: totalW, height: totalH)
            context.stroke(
                Path(boundRect),
                with: .color(.white.opacity(0.3)),
                lineWidth: 1
            )

            // Draw camera position
            let camGridX = Int(floor(cameraX / gridRes))
            let camGridY = Int(floor(cameraZ / gridRes))
            let camPxX = offsetX + CGFloat(camGridX - minX) * cellSize + cellSize / 2
            let camPxY = offsetY + CGFloat(camGridY - minY) * cellSize + cellSize / 2

            // Camera dot
            let dotSize: CGFloat = 8
            let dotRect = CGRect(
                x: camPxX - dotSize / 2,
                y: camPxY - dotSize / 2,
                width: dotSize,
                height: dotSize
            )
            context.fill(Path(ellipseIn: dotRect), with: .color(.red))

            // Camera direction indicator (small triangle)
            let arrowLen: CGFloat = 12
            let tipX = camPxX + arrowLen * CGFloat(sin(cameraYaw))
            let tipY = camPxY - arrowLen * CGFloat(cos(cameraYaw))

            var arrowPath = Path()
            arrowPath.move(to: CGPoint(x: camPxX, y: camPxY))
            arrowPath.addLine(to: CGPoint(x: tipX, y: tipY))
            context.stroke(arrowPath, with: .color(.red), lineWidth: 2)
        }
        .frame(width: mapSize, height: mapSize)
        .background(Color.black.opacity(0.6))
        .cornerRadius(12)
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color.white.opacity(0.2), lineWidth: 1)
        )
        .overlay(alignment: .topLeading) {
            Text("TOP VIEW")
                .font(.system(size: 8, weight: .bold, design: .monospaced))
                .foregroundColor(.white.opacity(0.5))
                .padding(6)
        }
    }
}
