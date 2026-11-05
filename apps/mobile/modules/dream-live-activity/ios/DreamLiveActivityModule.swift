import ActivityKit
import ExpoModulesCore

/// Reports the tokens Dream needs to drive Live Activities from the Worker:
/// the push-to-start token (iOS 17.2+) and each activity's update token.
/// It can also start one locally, which fixtures mode uses to show the widget.
public class DreamLiveActivityModule: Module {
  private var tasks: [Task<Void, Never>] = []
  private var observed = Set<String>()

  public func definition() -> ModuleDefinition {
    Name("DreamLiveActivity")

    Events("onPushToStartToken", "onActivityToken", "onActivityEnded")

    Function("areActivitiesEnabled") { () -> Bool in
      ActivityAuthorizationInfo().areActivitiesEnabled
    }

    Function("startObserving") {
      self.startObserving()
    }

    AsyncFunction("startLocal") { (attributesJson: String, contentJson: String) throws -> String in
      let decoder = JSONDecoder()
      let attributes = try decoder.decode(DreamActivityAttributes.self, from: Data(attributesJson.utf8))
      let state = try decoder.decode(DreamActivityAttributes.ContentState.self, from: Data(contentJson.utf8))
      let activity = try Activity.request(
        attributes: attributes,
        content: ActivityContent(state: state, staleDate: nil),
        pushType: .token
      )
      self.observe(activity)
      return activity.id
    }

    AsyncFunction("endAll") {
      for activity in Activity<DreamActivityAttributes>.activities {
        await activity.end(nil, dismissalPolicy: .immediate)
      }
    }

    OnDestroy {
      self.tasks.forEach { $0.cancel() }
    }
  }

  private func startObserving() {
    guard tasks.isEmpty else { return }
    if #available(iOS 17.2, *) {
      tasks.append(Task { [weak self] in
        for await data in Activity<DreamActivityAttributes>.pushToStartTokenUpdates {
          self?.sendEvent("onPushToStartToken", ["token": data.hexString])
        }
      })
    }
    tasks.append(Task { [weak self] in
      for await activity in Activity<DreamActivityAttributes>.activityUpdates {
        self?.observe(activity)
      }
    })
    for activity in Activity<DreamActivityAttributes>.activities {
      observe(activity)
    }
  }

  private func observe(_ activity: Activity<DreamActivityAttributes>) {
    guard !observed.contains(activity.id) else { return }
    observed.insert(activity.id)
    let projectId = activity.attributes.projectId
    tasks.append(Task { [weak self] in
      for await data in activity.pushTokenUpdates {
        self?.sendEvent("onActivityToken", [
          "activityId": activity.id,
          "projectId": projectId,
          "token": data.hexString
        ])
      }
    })
    tasks.append(Task { [weak self] in
      for await state in activity.activityStateUpdates where state == .ended || state == .dismissed {
        self?.sendEvent("onActivityEnded", ["activityId": activity.id, "projectId": projectId])
      }
    })
  }
}

private extension Data {
  var hexString: String { map { String(format: "%02x", $0) }.joined() }
}
