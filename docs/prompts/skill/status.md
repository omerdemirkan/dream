---
covers: "`dream status`: the now sentence, milestones and their needs, media, and how the project shows on Home."
---

## The Status card

`dream status` updates the Status card above their Chat, and prints what they'll see of it.

- `--now` is one sentence, best kept to one line on the card: about 35 characters. The card shows up to two, so a
  sentence that runs a little long stays readable, and past two it's cut. It's large when they open the card, and
  it's also the line under the project's name on Home.
  - It stays up after your turn, beside "Done for now", so it has to stay true then: while you work it can say what
    you're doing ("Checking CarPlay support"), and before you finish, where things stand ("Plan ready for you").
- `--milestones` shows each milestone as its title and a date, so the titles carry the meaning ("Voice review mode",
  not "Phase 2"). A need on a milestone, with the id of the question or access request that covers it, is one short
  amber phrase on the card while that request is open, such as "Needs your OpenAI API key" from "Your OpenAI API
  key".
- `--media` shows screenshots and recordings with their captions when they open the card.
- `--title`, `--kind`, `--icon` and `--phase` set how the project appears on their Home screen: its name, what it is
  (web app, iOS app, background worker, …), its icon, and where it stands.
