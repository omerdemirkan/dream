// Keep identical to targets/widget/DreamActivityAttributes.swift: ActivityKit
// matches the app's activities to the widget's by this type's name and shape.
// The shape mirrors LiveActivityAttributes / LiveActivityContent in
// packages/domain/src/LiveActivity.ts (flat, optional keys omitted, no dates).
import ActivityKit
import Foundation

public struct DreamActivityAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    public struct Step: Codable, Hashable {
      public var current: Int
      public var total: Int
    }
    public struct NeedsYou: Codable, Hashable {
      public var prompt: String
    }
    public var title: String
    public var detail: String?
    public var next: String?
    public var step: Step?
    public var badge: String?
    public var needsYou: NeedsYou?
  }

  public var projectId: String
  public var projectName: String
  public var icon: String?
}
