//  SavedScansView.swift
//  MoveViz — "내 스캔": 폰에 저장된 스캔 목록. 3D 보기 / 맥으로 재전송 / 삭제.
//  업로드가 실패해도 여기서 스캔을 다시 보내거나 오프라인으로 3D를 볼 수 있다.

import SwiftUI

struct SavedScansView: View {
    @ObservedObject var store: ScanStore
    @ObservedObject var up: ScanUploader
    @State private var modelURL: URL?
    @State private var planToShow: PlanData?
    @State private var showPlan = false

    var body: some View {
        NavigationStack {
            Group {
                if store.scans.isEmpty {
                    VStack(spacing: 10) {
                        Image(systemName: "tray").font(.largeTitle).foregroundStyle(.secondary)
                        Text("저장된 스캔 없음").font(.headline)
                        Text("LiDAR/카메라로 스캔하면 자동으로 여기에 저장됩니다.")
                            .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    }.padding()
                } else {
                    List {
                        ForEach(store.scans) { s in row(s) }
                            .onDelete { idx in idx.map { store.scans[$0] }.forEach(store.delete) }
                    }
                }
            }
            .navigationTitle("내 스캔")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    NavigationLink {
                        InventoryView()
                    } label: {
                        Label("이사 견적", systemImage: "shippingbox")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { store.reload() } label: { Image(systemName: "arrow.clockwise") }
                }
            }
            .onAppear { store.reload() }
            .sheet(item: $modelURL) { url in ModelViewerSheet(url: url) }
            .sheet(isPresented: $showPlan) {
                NavigationStack {
                    Group {
                        if let p = planToShow {
                            VStack(spacing: 4) {
                                FloorPlanView(plan: p)
                                Text("핀치 확대 · 드래그 이동 · 더블탭 초기화 · 치수 mm")
                                    .font(.caption2).foregroundStyle(.tertiary)
                                    .padding(.bottom, 6)
                            }
                        } else {
                            Text("평면도 데이터를 열 수 없습니다").foregroundStyle(.secondary)
                        }
                    }
                    .navigationTitle("평면도")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button("닫기") { showPlan = false }
                        }
                    }
                }
            }
        }
    }

    /// 저장된 스캔에서 평면도 로드: 서버 plan.json(귀속본) 우선, RoomPlan 스캔은 재생성.
    private func openPlan(_ s: SavedScan) {
        if s.hasPlan, let d = try? Data(contentsOf: s.planURL),
           let p = try? JSONDecoder().decode(PlanData.self, from: d) {
            planToShow = p; showPlan = true
        } else if s.hasRoomJSON {
            if #available(iOS 17.0, *) {
                planToShow = PlanData.fromCapturedRoomFile(s.roomJSONURL)
            } else {
                planToShow = nil
            }
            showPlan = true
        }
    }

    @ViewBuilder
    private func row(_ s: SavedScan) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: "cube.transparent").foregroundStyle(.blue)
                Text(dateText(s.date)).font(.subheadline.weight(.medium))
                Spacer()
                Text("\(s.vertexCount) 점").font(.caption).foregroundStyle(.secondary)
            }
            HStack(spacing: 6) {
                if s.keyframeCount > 0 {
                    Label("\(s.keyframeCount)", systemImage: "photo.stack").font(.caption2).foregroundStyle(.secondary)
                }
                Text(s.id).font(.caption2).foregroundStyle(.tertiary)
            }
            HStack(spacing: 10) {
                // 평면도: 서버 처리본(plan.json) 또는 RoomPlan 스캔이면 표시 가능
                if s.hasPlan || s.hasRoomJSON {
                    Button {
                        openPlan(s)
                    } label: { Label("평면도", systemImage: "square.split.bottomrightquarter").font(.caption) }
                        .buttonStyle(.bordered)
                }

                Button {
                    modelURL = s.bestModelURL   // 텍스처드 > RoomPlan usdz > obj
                } label: {
                    Label(s.hasTextured ? "3D 보기 (텍스처)" : "3D 보기",
                          systemImage: "view.3d").font(.caption)
                }
                    .buttonStyle(.bordered).disabled(s.bestModelURL == nil)

                // 정제(텍스처드) 모델과 별개로 원본 스캔 메쉬도 볼 수 있게
                if s.hasTextured, s.hasMesh || s.hasUSDZ {
                    Button {
                        modelURL = s.hasMesh ? s.meshURL : s.usdzURL
                    } label: { Label("원본 메쉬", systemImage: "square.3.layers.3d").font(.caption) }
                        .buttonStyle(.bordered)
                }

                Button {
                    if s.hasMesh {
                        up.upload(mesh: s.meshURL, mode: "lidar",
                                  keyframes: s.hasKeyframes ? s.keyframesURL : nil,
                                  linkID: s.id)
                    } else if s.hasUSDZ, s.hasRoomJSON,
                              let json = try? Data(contentsOf: s.roomJSONURL) {
                        up.uploadRoomPlan(usdz: s.usdzURL, roomJSON: json, linkID: s.id)
                    } else {
                        // 카메라(비-LiDAR) 스캔: 키프레임(zip)만 업로드
                        up.uploadKeyframes(folder: s.keyframesURL, linkID: s.id)
                    }
                } label: { Label("맥으로 전송", systemImage: "desktopcomputer").font(.caption) }
                    .buttonStyle(.borderedProminent)
                    .disabled(!s.hasMesh && !s.hasUSDZ && !s.hasKeyframes)
            }
            .padding(.top, 2)
        }
        .padding(.vertical, 4)
    }

    private func dateText(_ d: Date) -> String {
        let f = DateFormatter(); f.dateFormat = "M월 d일 HH:mm"; return f.string(from: d)
    }
}
