import ActivityKit
import SwiftUI
import WidgetKit

// Deck v3's Live Activity: the one place Dream gets playful. A violet-to-coral
// card while a project is busy; amber when it needs the person.

private let violet = Color(red: 0x4B / 255, green: 0x2F / 255, blue: 0xC0 / 255)
private let magenta = Color(red: 0xB0 / 255, green: 0x36 / 255, blue: 0x9C / 255)
private let coral = Color(red: 0xFF / 255, green: 0x8A / 255, blue: 0x5C / 255)
private let amber = Color(red: 0xFF / 255, green: 0xB3 / 255, blue: 0x5C / 255)
private let amberInk = Color(red: 0x1B / 255, green: 0x12 / 255, blue: 0x04 / 255)

private extension DreamActivityAttributes {
  var symbol: String { (icon?.isEmpty == false ? icon : nil) ?? "sparkle" }
  func link(_ state: ContentState) -> URL? {
    URL(string: state.needsYou != nil ? "dream://project/\(projectId)?tab=chat" : "dream://project/\(projectId)")
  }
}

struct DreamLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: DreamActivityAttributes.self) { context in
      LockScreenView(attributes: context.attributes, state: context.state)
        .activityBackgroundTint(context.state.needsYou != nil ? Color.black.opacity(0.85) : magenta)
        .activitySystemActionForegroundColor(.white)
        .widgetURL(context.attributes.link(context.state))
    } dynamicIsland: { context in
      let state = context.state
      let attributes = context.attributes
      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          HStack(spacing: 8) {
            Mark(symbol: attributes.symbol, needs: state.needsYou != nil, size: 30)
            Text(attributes.projectName).font(.system(size: 15, weight: .bold)).lineLimit(1)
          }
          .padding(.leading, 4)
        }
        DynamicIslandExpandedRegion(.trailing) {
          Badge(text: state.needsYou != nil ? "Needs you" : state.badge, needs: state.needsYou != nil)
            .padding(.trailing, 4)
        }
        DynamicIslandExpandedRegion(.bottom) {
          VStack(alignment: .leading, spacing: 10) {
            Text(state.needsYou?.prompt ?? state.title)
              .font(.system(size: 20, weight: .bold))
              .lineLimit(2)
            if state.needsYou == nil {
              if let step = state.step { Track(step: step, height: 6) }
              Foot(state: state)
            }
          }
          .padding(.horizontal, 4)
          .padding(.top, 4)
        }
      } compactLeading: {
        Mark(symbol: attributes.symbol, needs: state.needsYou != nil, size: 24)
      } compactTrailing: {
        if state.needsYou != nil {
          Circle().fill(amber).frame(width: 8, height: 8)
        } else if let step = state.step {
          Track(step: step, height: 5).frame(width: 64)
        } else {
          Text(state.badge ?? "").font(.system(size: 12, weight: .semibold))
        }
      } minimal: {
        if let step = state.step, state.needsYou == nil {
          Ring(fraction: Double(step.current) / Double(max(step.total, 1)))
        } else {
          Mark(symbol: attributes.symbol, needs: state.needsYou != nil, size: 22)
        }
      }
      .widgetURL(attributes.link(state))
      .keylineTint(state.needsYou != nil ? amber : coral)
    }
  }
}

struct LockScreenView: View {
  let attributes: DreamActivityAttributes
  let state: DreamActivityAttributes.ContentState

  var body: some View {
    let needs = state.needsYou != nil
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 9) {
        Mark(symbol: attributes.symbol, needs: needs, size: 26)
        Text(attributes.projectName).font(.system(size: 15, weight: .bold))
        Spacer(minLength: 8)
        Badge(text: needs ? "Needs you" : state.badge, needs: needs)
      }
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Text(state.needsYou?.prompt ?? state.title)
          .font(.system(size: 24, weight: .bold))
          .tracking(-0.8)
          .lineLimit(2)
          .minimumScaleFactor(0.8)
        if !needs { Dots() }
      }
      .padding(.top, 14)
      if let detail = state.detail, !needs {
        Text(detail).font(.system(size: 14)).foregroundStyle(.white.opacity(0.82)).padding(.top, 3).lineLimit(1)
      }
      if needs {
        Text("Tap to answer").font(.system(size: 14, weight: .semibold)).foregroundStyle(amber).padding(.top, 6)
      } else {
        if let step = state.step { Track(step: step, height: 7).padding(.top, 15) }
        Foot(state: state).padding(.top, 10)
      }
    }
    .foregroundStyle(.white)
    .padding(.horizontal, 17)
    .padding(.top, 15)
    .padding(.bottom, 16)
    .background {
      if needs {
        Color.black
      } else {
        ZStack(alignment: .topTrailing) {
          LinearGradient(colors: [violet, magenta, coral], startPoint: .topLeading, endPoint: .bottomTrailing)
          RadialGradient(colors: [.white.opacity(0.28), .clear], center: .center, startRadius: 0, endRadius: 85)
            .frame(width: 170, height: 170)
            .offset(x: 40, y: -50)
        }
      }
    }
  }
}

struct Mark: View {
  let symbol: String
  let needs: Bool
  let size: CGFloat

  var body: some View {
    ZStack {
      if needs {
        Circle().fill(amber)
      } else {
        RoundedRectangle(cornerRadius: size * 0.35, style: .continuous).fill(.white.opacity(0.22))
      }
      Image(systemName: symbol)
        .font(.system(size: size * 0.55, weight: .semibold))
        .foregroundStyle(needs ? amberInk : .white)
    }
    .frame(width: size, height: size)
  }
}

struct Badge: View {
  let text: String?
  let needs: Bool

  var body: some View {
    if let text, !text.isEmpty {
      Text(text)
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(needs ? amberInk : .white)
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .background(Capsule().fill(needs ? amber : .white.opacity(0.2)))
    }
  }
}

/// One segment per milestone: done, the current one half-lit, then what's left.
struct Track: View {
  let step: DreamActivityAttributes.ContentState.Step
  let height: CGFloat

  var body: some View {
    HStack(spacing: 5) {
      ForEach(0..<max(step.total, 1), id: \.self) { i in
        let index = i + 1
        Capsule()
          .fill(.white.opacity(index < step.current ? 1 : 0.28))
          .overlay(alignment: .leading) {
            if index == step.current {
              GeometryReader { proxy in
                Capsule().fill(.white).frame(width: proxy.size.width / 2)
              }
            }
          }
          .frame(height: height)
      }
    }
  }
}

struct Foot: View {
  let state: DreamActivityAttributes.ContentState

  var body: some View {
    HStack {
      if let next = state.next { Text("Next · \(next)").lineLimit(1) }
      Spacer(minLength: 8)
      if let step = state.step { Text("\(step.current) of \(step.total)") }
    }
    .font(.system(size: 12.5, weight: .semibold))
    .foregroundStyle(.white.opacity(0.88))
  }
}

struct Dots: View {
  var body: some View {
    HStack(spacing: 3) {
      ForEach(0..<3, id: \.self) { i in
        Circle().fill(.white.opacity(i == 1 ? 1 : 0.6)).frame(width: 5, height: 5)
      }
    }
  }
}

struct Ring: View {
  let fraction: Double

  var body: some View {
    ZStack {
      Circle().stroke(.white.opacity(0.25), lineWidth: 3)
      Circle()
        .trim(from: 0, to: fraction)
        .stroke(coral, style: StrokeStyle(lineWidth: 3, lineCap: .round))
        .rotationEffect(.degrees(-90))
    }
    .padding(2)
  }
}
