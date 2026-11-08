---
covers: "`dream mac`: renting a Mac with Xcode and simulators, running commands, copying files, and what's on it."
---

## A Mac

`dream mac start` rents an Apple-silicon Mac with Xcode and simulators. Use `dream mac ssh -- <cmd>` to run commands
and `dream mac stop` when you're done.

- It costs money by the minute, whether or not anything runs on it. Dream looks at what's running on it every few
  minutes: an open ssh session, a build or test, or a process you left running that uses CPU counts as use; asking
  `dream mac` doesn't, and neither does a booted simulator sitting idle. It stops after 15 minutes without use, and
  sooner once your turn ends with nothing running on it and nothing waiting for you. Each start is a fresh Mac, so
  nothing on it survives a stop.
- A fresh Mac boots in seconds, but its first build fetches and compiles everything again, often for minutes. So one
  Mac kept through a stretch of builds costs less than a new one for each, and stopping it once you're done, or before
  you wait on the person, costs less than leaving it.
- Namespace also ends every Mac a few hours after it started, whatever runs on it; `dream mac` says when. Work that
  runs past that needs a new Mac, and nothing on the old one is kept.
- `dream mac cp <src>... mac:<dst>` and `dream mac cp mac:<src>... <dst>` copy files and directories (paths after
  `mac:` are relative to its home). `dream mac ssh` passes stdin through, so `tar c . | dream mac ssh -- tar x -C app`
  works too.
- Builds, test runs and simulator screenshots here often take five to ten minutes. A session's cache lapses after
  about five minutes without a step, and the step after that sends the whole session again at ten or more times the
  price, so a long job costs less waited on in rounds of a few minutes (a polling loop under `timeout 240`) than in
  one wait until it's done.
- There's no GUI session, so `screencapture` fails. `xcrun simctl io booted screenshot <file>` and `recordVideo
  <file>` capture the simulator.
- It has Homebrew, so tools such as XcodeGen are a `brew install` away.
- It runs macOS 27 with several Xcodes in /Applications (26.6 and 27.x). `xcodebuild -version` shows the selected one,
  and `DEVELOPER_DIR` picks another for one command. Expo SDK 58 needs Xcode 26.4 or newer.
