/**
 * The Live Activity (lock screen and Dynamic Island) for a project, driven by
 * `dream live` through APNs. See DreamLiveActivity.swift.
 * @type {import('@bacons/apple-targets/app.plugin').ConfigFunction}
 */
module.exports = () => ({
  type: "widget",
  name: "DreamWidget",
  displayName: "Dream",
  icon: "../../assets/images/icon.png",
  // Live Activities need 16.2; push-to-start is gated in code on 17.2.
  deploymentTarget: "16.4",
  frameworks: ["SwiftUI", "WidgetKit", "ActivityKit"],
  colors: {
    $widgetBackground: "#0A0A0C",
    $accent: "#FFB35C"
  }
})
