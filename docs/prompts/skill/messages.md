---
covers: "`dream message`: what Chat renders, attaching media, notifying, withdrawing a notification, and the files they attach."
---

## Messages

`dream message "…"` puts a message in their Chat. Chat renders paragraphs, lists, bold, italic, code and links;
headings show as bold lines, and a table as one line per row.

- `--media <file>` attaches a screenshot or a recording (png, jpg, or mp4).
- `--notify` also puts its opening lines on their lock screen, as plain text. `dream notify withdraw <id>` removes a
  notification that no longer applies, yours or one of your apps'. An answered question withdraws its own.
- Most messages read best as a few short paragraphs, the way a person writes to someone they work with. A list suits
  things that really are one, such as steps to follow. A list where every item opens with a bold label reads as a
  generated report, however true each item is.
- `dream message -` (or no text, with stdin piped) reads the message from stdin, so `dream message - <<'EOF'` keeps
  long markdown out of shell quoting.
- They can attach photos and files to what they send, a new idea included. Before your turn, Dream copies each into
  `~/.dream/attachments/<message id>/`, and the event names every path, so you can look at a photo or read a file
  where it is. Photos arrive downscaled to at most 2048 pixels on the long edge. Copy one into the project if your
  app needs it.
