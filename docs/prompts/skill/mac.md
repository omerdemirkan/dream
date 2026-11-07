---
covers: "`dream mac`: renting a Mac with Xcode and simulators, running commands, copying files, and what's on it."
---

## A Mac

`dream mac start` rents an Apple-silicon Mac with Xcode and simulators. Use `dream mac ssh -- <cmd>` to run commands
and `dream mac stop` when you're done.

- It costs money by the minute, and it stops itself after 20 idle minutes. Each start is a fresh Mac, so nothing on it
  survives `dream mac stop`.
- `dream mac cp <src>... mac:<dst>` and `dream mac cp mac:<src>... <dst>` copy files and directories (paths after
  `mac:` are relative to its home). `dream mac ssh` passes stdin through, so `tar c . | dream mac ssh -- tar x -C app`
  works too.
- There's no GUI session, so `screencapture` fails. `xcrun simctl io booted screenshot <file>` and `recordVideo
  <file>` capture the simulator.
- It has Homebrew, so tools such as XcodeGen are a `brew install` away.
- It runs macOS 27 with several Xcodes in /Applications (26.6 and 27.x). `xcodebuild -version` shows the selected one,
  and `DEVELOPER_DIR` picks another for one command. Expo SDK 58 needs Xcode 26.4 or newer.
