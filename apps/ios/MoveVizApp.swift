import SwiftUI

@main
struct MoveVizApp: App {
    var body: some Scene {
        WindowGroup {
            RootTabView()             // LiDAR / 카메라(비-LiDAR) 탭 → 맥 전송 → 평면도 결과
                .preferredColorScheme(.dark)
        }
    }
}
