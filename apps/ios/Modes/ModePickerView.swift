//  ModePickerView.swift
//  MoveViz — 3가지 스캔 모드 진입 화면(테스트 하네스)
//
//  사용자가 LiDAR / RoomPlan / 카메라전용(비-LiDAR)을 "따로" 골라 테스트한다.
//  각 모드의 기기 지원 여부(LiDAR·RoomPlan·Object Capture)를 표시한다.
//  앱 진입점(MoveVizApp)이 이 화면을 띄운다.

import SwiftUI
import ARKit
#if canImport(RoomPlan)
import RoomPlan
#endif
#if canImport(RealityKit)
import RealityKit
#endif

struct ModePickerView: View {

    private var lidarOK: Bool { ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh) }
    private var arOK: Bool { ARWorldTrackingConfiguration.isSupported }
    private var roomplanOK: Bool {
        if #available(iOS 17.0, *) { return RoomCaptureSession.isSupported }
        return false
    }
    private var objcapOK: Bool {
        if #available(iOS 17.0, *) { return PhotogrammetrySession.isSupported }
        return false
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    NavigationLink { ScanningView() } label: {
                        modeRow("📐 LiDAR 스캔", "메시·점군 → 평면도 (정밀 기하)", lidarOK, "LiDAR 필요")
                    }
                    if #available(iOS 17.0, *) {
                        NavigationLink { RoomPlanSpikeEntry() } label: {
                            modeRow("🏠 RoomPlan", "시맨틱 벽/문/창/가구 + 메시 동시", roomplanOK, "LiDAR + iOS17 필요")
                        }
                        NavigationLink { CameraOnlyScanView() } label: {
                            modeRow("📷 카메라 전용 (비-LiDAR)", "사진 → Object Capture → 3D", objcapOK, "iOS17 + A14↑ (LiDAR 불필요)")
                        }
                    }
                } header: {
                    Text("스캔 모드 — 3가지를 따로 테스트")
                } footer: {
                    Text("각 모드는 캡처 방식이 다릅니다. 미지원 기기여도 진입은 가능하며 화면에서 안내합니다.")
                }

                Section("이 기기 지원 현황") {
                    capRow("ARKit", arOK)
                    capRow("LiDAR (sceneReconstruction)", lidarOK)
                    capRow("RoomPlan", roomplanOK)
                    capRow("Object Capture (PhotogrammetrySession)", objcapOK)
                }
            }
            .navigationTitle("MoveViz")
            .navigationBarTitleDisplayMode(.large)
        }
    }

    private func modeRow(_ title: String, _ subtitle: String, _ ok: Bool, _ req: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(title).font(.headline)
                Spacer()
                Text(ok ? "지원" : "미지원")
                    .font(.caption2.bold())
                    .foregroundStyle(ok ? .green : .orange)
            }
            Text(subtitle).font(.subheadline).foregroundStyle(.secondary)
            Text(req).font(.caption2).foregroundStyle(.tertiary)
        }
        .padding(.vertical, 4)
    }

    private func capRow(_ name: String, _ ok: Bool) -> some View {
        HStack {
            Image(systemName: ok ? "checkmark.circle.fill" : "xmark.circle")
                .foregroundStyle(ok ? .green : .secondary)
            Text(name).font(.subheadline)
        }
    }
}
