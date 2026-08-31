//  RoomScanView.swift
//  PlanShot — 현장 안에서 방 하나 스캔(RoomPlan, 온디바이스) → 이름 붙여 현장에 추가.
//
//  RoomPlanSpikeManager를 그대로 쓴다(스캔·CapturedRoom→2D·USDZ·'내 스캔' 저장).
//  완료 시: PlanData(천장고 포함)를 plan.json으로 스캔 폴더에 귀속 → 프로젝트에 방 등록.
//  맥 서버 업로드는 없음 — 제안서 p8 "폰 단독 완결".

import SwiftUI
import RoomPlan

@available(iOS 17.0, *)
struct RoomScanView: View {
    let projectID: String
    @Environment(\.dismiss) private var dismiss
    @StateObject private var mgr = RoomPlanSpikeManager()
    @ObservedObject private var projects = ProjectStore.shared
    @State private var roomName = ""
    @State private var customName = ""
    @State private var show3D: URL?
    @State private var saveError: String?

    private var effectiveName: String {
        roomName == "직접 입력" ? customName.trimmingCharacters(in: .whitespaces) : roomName
    }

    /// 결과 미리보기용 PlanData (천장고 = 벽 높이 중앙값).
    private var previewPlan: PlanData? {
        PlanData.fromRoomPlan(
            walls: mgr.walls2D, doors: mgr.doors2D, windows: mgr.windows2D,
            furniture: mgr.furnitureList.map {
                (cat: $0.cat, ko: $0.name, cx: Double($0.cx), cz: Double($0.cz),
                 w: Double($0.w), d: Double($0.d), yaw: Double($0.yaw))
            },
            ceiling: mgr.ceilingM > 0 ? mgr.ceilingM : nil,
            roomName: effectiveName.isEmpty ? nil : effectiveName,
            floorPolygon: mgr.floor2D.isEmpty ? nil : mgr.floor2D,
            doorHeights: mgr.doorHeights, windowHeights: mgr.windowHeights)
    }

    var body: some View {
        NavigationStack {
            ZStack {
                if mgr.done { results } else { capture }
            }
            .navigationTitle(mgr.done ? "스캔 결과" : "방 스캔")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("닫기") { if mgr.isScanning { mgr.stop() }; dismiss() }
                }
            }
        }
        .sheet(item: $show3D) { url in ModelViewerSheet(url: url) }
        .onAppear {
            if roomName.isEmpty { roomName = projects.suggestedRoomName(for: projectID) }
        }
    }

    // MARK: 스캔

    private var capture: some View {
        ZStack(alignment: .bottom) {
            RoomCaptureViewRepresentable(manager: mgr).ignoresSafeArea()
            VStack(spacing: 12) {
                Text(mgr.status).font(.footnote.weight(.semibold)).foregroundStyle(.white)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(.black.opacity(0.55), in: Capsule())
                if mgr.isScanning {
                    Text("벽 \(mgr.wallCount) · 문 \(mgr.doorCount) · 창 \(mgr.windowCount) · 가구 \(mgr.objectCount)")
                        .font(.caption.monospacedDigit()).foregroundStyle(.white)
                        .padding(.horizontal, 10).padding(.vertical, 6)
                        .background(.black.opacity(0.5), in: Capsule())
                    Button(role: .destructive, action: mgr.stop) {
                        Label("스캔 종료 → 도면", systemImage: "stop.fill").frame(maxWidth: .infinity)
                    }.buttonStyle(.borderedProminent)
                } else {
                    Button(action: mgr.start) {
                        Label("스캔 시작 (방을 천천히 한 바퀴)", systemImage: "play.fill")
                            .frame(maxWidth: .infinity)
                    }.buttonStyle(.borderedProminent)
                }
            }
            .padding(16)
        }
    }

    // MARK: 결과

    private var results: some View {
        ScrollView {
            VStack(spacing: 14) {
                PSStepBar(steps: ["스캔", "도면 확인", "현장에 추가"], current: 1).padding(.top, 6)
                HStack(spacing: 16) {
                    stat(String(format: "%.1f㎡", mgr.floorAreaM2), "면적")
                    stat(mgr.ceilingM > 0 ? PlanUnits.mmText(mgr.ceilingM) : "-", "천장고")
                    stat("\(mgr.wallCount)", "벽")
                    stat("\(mgr.doorCount)", "문")
                    stat("\(mgr.windowCount)", "창")
                    stat("\(mgr.objectCount)", "가구")
                }.padding(.top, 8)

                if let plan = previewPlan {
                    FloorPlanView(plan: plan, sheet: PlanSheetInfo(roomName: effectiveName, showTitleBlock: false))
                        .frame(height: 340)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(.quaternary, lineWidth: 1))
                        .padding(.horizontal)
                } else {
                    Text("벽이 2개 미만이라 평면도를 만들 수 없습니다 — 다시 스캔하세요")
                        .font(.footnote).foregroundStyle(.orange).padding()
                }

                // 방 이름
                VStack(alignment: .leading, spacing: 6) {
                    Text("방 이름").font(.caption.bold()).foregroundStyle(.secondary)
                    Picker("방 이름", selection: $roomName) {
                        ForEach(ProjectStore.roomPresets, id: \.self) { Text($0).tag($0) }
                        Text("직접 입력").tag("직접 입력")
                    }
                    .pickerStyle(.menu)
                    if roomName == "직접 입력" {
                        TextField("예: 서재", text: $customName).textFieldStyle(.roundedBorder)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal)

                if let e = saveError {
                    Text(e).font(.caption).foregroundStyle(.orange)
                }

                Button(action: save) {
                    Label("현장에 추가", systemImage: "checkmark.circle.fill").frame(maxWidth: .infinity)
                }
                .buttonStyle(PSPrimaryButton())
                .disabled(previewPlan == nil || effectiveName.isEmpty)
                .padding(.horizontal)

                HStack(spacing: 10) {
                    if let u = mgr.usdzURL {
                        Button { show3D = u } label: {
                            Label("3D 보기", systemImage: "rotate.3d").frame(maxWidth: .infinity)
                        }.buttonStyle(PSSecondaryButton())
                    }
                    Button(action: mgr.rescan) {
                        Label("다시 스캔", systemImage: "arrow.clockwise").frame(maxWidth: .infinity)
                    }.buttonStyle(PSSecondaryButton())
                }
                .padding(.horizontal).padding(.bottom, 20)
            }
        }
        .background(PSTheme.canvas.ignoresSafeArea())
    }

    private func save() {
        guard let plan = previewPlan else { saveError = "평면도를 만들 수 없습니다"; return }
        guard let sid = mgr.lastSavedScanID else {
            saveError = "스캔 저장에 실패했습니다 — 다시 스캔해 주세요"; return
        }
        if let data = try? JSONEncoder().encode(plan) {
            ScanStore.shared.attachPlan(data, toScanID: sid)
        }
        projects.addRoom(to: projectID, name: effectiveName, scanID: sid)
        dismiss()
    }

    private func stat(_ v: String, _ l: String) -> some View {
        VStack(spacing: 2) {
            Text(v).font(.subheadline.bold().monospacedDigit())
            Text(l).font(.caption2).foregroundStyle(.secondary)
        }
    }
}
