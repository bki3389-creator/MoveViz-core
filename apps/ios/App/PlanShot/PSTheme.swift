//  PSTheme.swift
//  PlanShot — 디자인 토큰 + 공용 컴포넌트 (버튼·카드·배지·빈 상태).
//
//  브랜드: 짙은 남색 잉크(도면 선) + 시안 강조(실측·LiDAR) + 따뜻한 종이색 카드.
//  다크 모드 기본(앱 루트가 .dark). 도면/PDF는 항상 흰 종이.

import SwiftUI

enum PSTheme {
    static let accent = Color(red: 0.13, green: 0.62, blue: 0.85)        // 시안 — 실측/LiDAR
    static let accentSoft = Color(red: 0.13, green: 0.62, blue: 0.85).opacity(0.16)
    static let ink = Color(red: 0.10, green: 0.14, blue: 0.22)           // 도면 잉크(라이트 텍스트용)
    static let warn = Color.orange
    static let ok = Color(red: 0.20, green: 0.72, blue: 0.45)
    static let canvas = Color(.systemGroupedBackground)
    static let card = Color(.secondarySystemGroupedBackground)
    static let radius: CGFloat = 14

    static let titleFont = Font.system(.title2, design: .rounded).weight(.bold)
    static let numberFont = Font.system(.title3, design: .rounded).weight(.bold).monospacedDigit()
}

// MARK: - 버튼

struct PSPrimaryButton: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .padding(.vertical, 13).padding(.horizontal, 14)
            .frame(maxWidth: .infinity)
            .background(enabled ? PSTheme.accent : Color.gray.opacity(0.35),
                        in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .foregroundStyle(.white)
            .opacity(configuration.isPressed ? 0.8 : 1)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

struct PSSecondaryButton: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .padding(.vertical, 13).padding(.horizontal, 14)
            .frame(maxWidth: .infinity)
            .background(PSTheme.accentSoft, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .foregroundStyle(PSTheme.accent)
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

// MARK: - 카드 / 통계 / 배지

struct PSCard<Content: View>: View {
    var title: String? = nil
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let title {
                Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    .textCase(.uppercase)
            }
            content
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(PSTheme.card, in: RoundedRectangle(cornerRadius: PSTheme.radius, style: .continuous))
    }
}

struct PSStat: View {
    let value: String
    let label: String
    var tint: Color = .primary
    var body: some View {
        VStack(spacing: 3) {
            Text(value).font(PSTheme.numberFont).foregroundStyle(tint)
                .lineLimit(1).minimumScaleFactor(0.6)
            Text(label).font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }
}

struct PSBadge: View {
    let text: String
    var color: Color = PSTheme.accent
    var body: some View {
        Text(text).font(.caption2.weight(.semibold))
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(color.opacity(0.18), in: Capsule())
            .foregroundStyle(color)
    }
}

struct PSEmptyState: View {
    let icon: String
    let title: String
    let message: String
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil
    var body: some View {
        VStack(spacing: 12) {
            ZStack {
                Circle().fill(PSTheme.accentSoft).frame(width: 84, height: 84)
                Image(systemName: icon).font(.system(size: 34, weight: .medium)).foregroundStyle(PSTheme.accent)
            }
            Text(title).font(.headline)
            Text(message).font(.footnote).foregroundStyle(.secondary)
                .multilineTextAlignment(.center).padding(.horizontal, 30)
            if let actionTitle, let action {
                Button(action: action) { Label(actionTitle, systemImage: "plus") }
                    .buttonStyle(PSPrimaryButton()).frame(maxWidth: 220).padding(.top, 6)
            }
        }
        .frame(maxWidth: .infinity).padding(.vertical, 40)
    }
}

/// 스캔 흐름 진행 단계 표시 (스캔 → 도면 → PDF) — 제안서 p2의 3단계.
struct PSStepBar: View {
    let steps: [String]
    let current: Int
    var body: some View {
        HStack(spacing: 6) {
            ForEach(Array(steps.enumerated()), id: \.offset) { i, s in
                HStack(spacing: 5) {
                    Circle().fill(i <= current ? PSTheme.accent : Color.gray.opacity(0.3))
                        .frame(width: 8, height: 8)
                    Text(s).font(.caption2.weight(i == current ? .semibold : .regular))
                        .foregroundStyle(i <= current ? .primary : .secondary)
                }
                if i < steps.count - 1 {
                    Rectangle().fill(Color.gray.opacity(0.25)).frame(height: 1).frame(maxWidth: 28)
                }
            }
        }
    }
}
