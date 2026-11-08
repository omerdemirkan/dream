---
covers: "`dream ask`: the question card, options with screenshots, recordings or audio, answers, and withdrawing."
---

## Questions

`dream ask "…" --option "…" --option "…"` shows a question card in Chat and sends a notification. The question is
the card's heading, in large type, and it's what the notification shows, often with nothing around it.

- `--why` adds the one-line reason shown under the question. When deciding takes more than that, such as two options
  and what each costs them, `--context` adds it in markdown at body size: the card shows its first few lines, and all
  of it when they open the card. `--meanwhile` says what you'll keep doing. Each of these, and the question, can be
  read from stdin with `-`.
- They can pick an option, or open the question and write anything, typed or dictated.
- `--show "<option>=<files>"` attaches what an option looks or sounds like: screenshots (png, jpg) at any size, a
  recording (mp4), or audio (mp3, m4a, wav). It takes a file, a glob, or several separated by commas, shown in name
  order, each captioned with its file name ("2-the-clash.png" reads "The clash"). Repeat it for each option.
  - The card shows a thumbnail of each option at its own shape, and they open full screen to swipe between them. A
    phone screenshot fills the screen, a desktop page shows across it and turns sideways when they want it larger,
    recordings play with the usual controls, and once they play a sound, swiping to the next plays its sound. So take
    every option at the same size and at the same moments, in the same order: the same page, the same state, the
    same data.
  - Picking asks for a note, which often names what to take from another option, and "None of these" comes back in
    their words. Both arrive in the answer.
  - An option shows up to 8 files, and a question 24. Older versions of the app show the options as buttons, so they
    still need to make sense as words. Audio goes only here, not in messages or the Status card.
  - The options are cheap to make with a subagent each, in a worktree of its own (`git worktree add`), with throwaway
    code and the same seed data. Once they pick, build on the chosen one and delete the rest.
- Their answer arrives as an event. Until they answer, the card stays open in Chat, the Status card carries an amber
  line for it, and their Home screen marks the project as waiting for them.
- Answers are visible in Chat and arrive in this sandbox, so `dream ask` refuses questions that ask for a token, key,
  password or other credential. Ask for those with `dream access`. `--not-a-secret` sends a question that only
  mentions one.
- `dream ask withdraw <id>` takes back a question that no longer needs an answer, and `dream ask revise <id>`
    changes one that's still open (see Threads).
