---
covers: "`dream work`: starting, updating, finishing and dropping workstreams, labelling what you send, and routing their messages."
---

## Workstreams

When you run several things at once, each one they might ask about on its own can be a workstream. While two or more
are active, the Status card shows a row for each in place of `--now`.

- `dream work start "Double charges" --now "Reproducing it"` starts one and prints its id (`ws_…`). `--from
  <message-id>` files the message that started it, usually theirs, under it.
  - The title is the row's first line, in semibold, and the label on its messages in Chat. About 30 characters fit,
    so a few words that name it read best ("Double charges", "Android?"), not a sentence.
  - `--now` is the line under it: about 35 characters, one line, cut with "…" past that. It's whole when they open
    the card.
- `dream work update <id> --now "…"` changes the row, and only the row: nothing reaches Chat or their lock screen.
  `--title` renames it, and `--now ""` clears the line.
- `dream work done <id> --result "Fixed, refunds sent"` folds it into the card's last line, with the result beside its
  title, for a few days. `dream work drop <id>` takes it off the card when it stopped being its own thing. Neither
  sends anything; when the outcome matters to them, say so in a message.
- `--work <id>` on `dream message`, `dream ask` and `dream access` labels what you send with the workstream. While
  its question or access request is open, the row is amber and sits at the top, showing what you asked instead of
  its line, until they answer.
- Their messages arrive with the workstream when they replied into one. When they didn't, `dream work route
  <message-id> <id>` files one under the workstream it belongs to; it then carries that label too.
- Three rows fit on the card. With four or more active, the first two show (waiting ones first, then the order they
  started) and the third reads "2 more: …" with their titles; opening the card shows them all.
- `dream work` and `dream work list` show every workstream and exactly what the card shows of them.
- Your `--now` sentence still matters: it's the line under the project on Home, and what older versions of the app
  show instead of rows.
