//  ResultView.swift
//  MoveViz — 맥에서 처리된 평면도 결과를 온디바이스에서 본다.
//
//  평면도: plan.json 벡터를 FloorPlanView(Canvas)로 네이티브 렌더(핀치줌·팬).
//  3D: colored.usdz를 자동 다운로드해 인라인 렌더 + 전체화면(QuickLook, AR) 버튼.

import SwiftUI

struct ResultView: View {
    @ObservedObject var up: ScanUploader
    @State private var texturedModel: URL?      // 전체화면 시트용
    @State private var inlineModel: URL?        // 인라인 3D용(자동 다운로드)
    @State private var downloading = false
    @State private var showRasterPlan = false   // 벡터↔서버 PNG 토글
    @State private var planMode = 0             // 0 = 2D 평면, 1 = 3D 평면

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    // 상태
                    HStack(spacing: 8) {
                        if up.busy { ProgressView() }
                        Text(up.status).font(.subheadline.weight(.medium))
                            .multilineTextAlignment(.center)
                    }
                    .padding(.top, 8)

                    // 서버가 done이어도 일부 단계(비전 등) 실패 시 경고 표면화
                    if up.done, let err = up.summary?.error, !err.isEmpty {
                        Label(err, systemImage: "exclamationmark.triangle.fill")
                            .font(.caption)
                            .padding(10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(.orange.opacity(0.15),
                                        in: RoundedRectangle(cornerRadius: 10))
                            .padding(.horizontal)
                    }

                    if up.busy && !up.done {
                        VStack(spacing: 10) {
                            ProgressView().scaleEffect(1.4)
                            Text("맥에서 평면도를 만드는 중…")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 60)
                    }

                    // 평면도 — 2D/3D 벡터(기본) / 서버 PNG(토글)
                    if up.done {
                        if let plan = up.planData, !showRasterPlan {
                            VStack(spacing: 8) {
                                Picker("평면도 보기", selection: $planMode) {
                                    Text("2D 평면").tag(0)
                                    Text("3D 평면").tag(1)
                                }
                                .pickerStyle(.segmented)
                                Group {
                                    if planMode == 0 {
                                        FloorPlanView(plan: plan)
                                    } else {
                                        FloorPlan3DView(plan: plan)
                                    }
                                }
                                .frame(height: 400)
                                .clipShape(RoundedRectangle(cornerRadius: 12))
                                .overlay(RoundedRectangle(cornerRadius: 12)
                                    .stroke(.quaternary, lineWidth: 1))
                                Text(planMode == 0 ? "핀치 확대 · 드래그 이동 · 더블탭 초기화"
                                                   : "드래그 회전 · 핀치 확대")
                                    .font(.caption2).foregroundStyle(.tertiary)
                            }
                            .padding(.horizontal)
                        } else if let url = URL(string: up.planImageURL), !up.planImageURL.isEmpty {
                            AsyncImage(url: url) { phase in
                                switch phase {
                                case .success(let img):
                                    img.resizable().scaledToFit()
                                        .background(Color.white)
                                        .clipShape(RoundedRectangle(cornerRadius: 12))
                                case .failure:
                                    Text("이미지 로드 실패").foregroundStyle(.secondary)
                                default:
                                    ProgressView()
                                }
                            }
                            .padding(.horizontal)
                        }
                        if up.planData != nil, !up.planImageURL.isEmpty {
                            Toggle("서버 렌더(PNG)로 보기", isOn: $showRasterPlan)
                                .font(.caption).padding(.horizontal, 24)
                        }
                    }

                    // 공간유형(비전 추론)
                    if up.done, let st = up.summary?.space_type, st != "unknown" {
                        HStack(spacing: 8) {
                            Image(systemName: spaceIcon(st))
                            Text("공간유형: \(spaceLabel(st))").font(.subheadline.bold())
                            if let n = up.summary?.furniture_vision {
                                Text("· 가구 \(n)개(비전)").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .padding(.horizontal, 12).padding(.vertical, 7)
                        .background(.blue.opacity(0.15), in: Capsule())
                    }

                    // 인라인 3D 프리뷰 (정점색 USDZ — 자동 다운로드)
                    if up.done, !up.coloredUSDZURL.isEmpty {
                        VStack(spacing: 6) {
                            Text("3D 프리뷰").font(.caption.bold()).foregroundStyle(.secondary)
                            if let m = inlineModel {
                                ModelViewer(url: m)
                                    .frame(height: 320)
                                    .clipShape(RoundedRectangle(cornerRadius: 12))
                                HStack(spacing: 8) {
                                    Button {
                                        texturedModel = m
                                    } label: {
                                        Label("전체화면 · AR", systemImage: "arkit")
                                            .frame(maxWidth: .infinity)
                                    }
                                    .buttonStyle(.borderedProminent)
                                    // 정제 3D와 별개로 원본 스캔 메쉬 보기
                                    if let id = up.linkedScanID,
                                       let scan = ScanStore.shared.scans.first(where: { $0.id == id }),
                                       scan.hasMesh || scan.hasUSDZ {
                                        Button {
                                            texturedModel = scan.hasMesh ? scan.meshURL : scan.usdzURL
                                        } label: {
                                            Label("원본 메쉬", systemImage: "square.3.layers.3d")
                                                .frame(maxWidth: .infinity)
                                        }
                                        .buttonStyle(.bordered)
                                    }
                                }
                            } else {
                                HStack(spacing: 8) {
                                    ProgressView()
                                    Text("3D 모델 받는 중…").font(.caption).foregroundStyle(.secondary)
                                }
                                .frame(height: 60)
                            }
                        }
                        .padding(.horizontal)
                        .task(id: up.coloredUSDZURL) {
                            // URL(스캔 id 포함)이 바뀔 때마다 재실행 — 이전 스캔 모델 폐기 후 재다운로드.
                            guard !up.coloredUSDZURL.isEmpty else { return }
                            inlineModel = nil
                            inlineModel = await up.downloadToTemp(up.coloredUSDZURL)
                            // 업로드가 '내 스캔'에서 온 것이면 텍스처드 USDZ를 그 폴더에
                            // 귀속 → 오프라인에서도 '3D 보기 (텍스처)' 가능.
                            if let m = inlineModel, let id = up.linkedScanID {
                                ScanStore.shared.attachTextured(usdz: m, toScanID: id)
                            }
                        }
                    }

                    // 가구 비전 탑뷰 (OWLv2 회전박스 + 카테고리 라벨)
                    if up.done, !up.furnitureImageURL.isEmpty, let furl = URL(string: up.furnitureImageURL) {
                        Text("가구 인식 (비전/OWLv2)").font(.caption.bold()).foregroundStyle(.secondary)
                        AsyncImage(url: furl) { img in
                            img.resizable().scaledToFit().background(Color.white)
                                .clipShape(RoundedRectangle(cornerRadius: 12))
                        } placeholder: { ProgressView() }
                        .padding(.horizontal)
                    }

                    // 요약
                    if let s = up.summary {
                        HStack(spacing: 18) {
                            stat("\(s.area_m2.map { String(format: "%.1f", $0) } ?? "-")㎡", "면적")
                            stat("\(s.doors ?? 0)", "문")
                            stat("\(s.windows ?? 0)", "창")
                            stat("\(s.rooms ?? 0)", "방")
                            stat("\(s.furniture ?? 0)", "가구")
                        }
                        .padding(.vertical, 6)
                    }
                }
                .padding(.bottom, 24)
            }
            .navigationTitle("평면도 결과")
            .navigationBarTitleDisplayMode(.inline)
            .sheet(item: $texturedModel) { url in ModelViewerSheet(url: url) }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("닫기") { up.present = false }
                }
            }
        }
    }

    private func spaceLabel(_ t: String) -> String {
        ["home": "집/주거", "office": "사무실", "cafe": "카페", "retail": "매장", "warehouse": "창고", "bathroom": "욕실"][t] ?? t
    }
    private func spaceIcon(_ t: String) -> String {
        ["home": "house.fill", "office": "building.2.fill", "cafe": "cup.and.saucer.fill",
         "retail": "bag.fill", "warehouse": "shippingbox.fill", "bathroom": "shower.fill"][t] ?? "questionmark.circle"
    }
    private func stat(_ v: String, _ l: String) -> some View {
        VStack(spacing: 2) {
            Text(v).font(.headline)
            Text(l).font(.caption2).foregroundStyle(.secondary)
        }
    }
}
