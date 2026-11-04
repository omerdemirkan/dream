# Dream — mock brief (shared by all directions)

## What Dream is
Dream is an iOS app (React Native, TestFlight first) for people who have more ideas than time. You say or type
an idea; an agent (the "foreman") talks it through with you, may build quick throwaway prototypes in divergent
directions for your snap reactions, gets your go-ahead, then builds the real thing at very high fidelity for
hours, days, or weeks inside its own cloud computer. It hosts what it builds from that computer (web apps,
backends, background workers; iOS apps go to your phone through TestFlight). It maintains it afterwards: it sets
up its own alerts and wakes itself to fix things.

Users: technical-ish people with $100–$500/month Claude or ChatGPT subscriptions, little time, ambitious ideas.
They use Dream to get high-fidelity versions of ideas to play with, or personal software that really works.

## What matters in the UI
- The agent drives; the user steers. After kickoff the user mostly answers questions and looks at results.
- Each project = one agent. Opening a project shows a living status card the agent keeps current, NOT a chat.
  Card content: what it's doing now (if anything), what it just did, what's next, what it needs from you now,
  what it will need later (while it keeps building around it), and media: screenshots and short screen
  recordings. Chat/transcript exists but is one tap away and visually secondary.
- Lovable/Replit turn long runs into a wall of text. Dream must never feel like that.
- Notifications are first class. Tapping one opens a focused "portal": one question, a TL;DR, just enough
  context, fast ways to answer (choices, type, or talk), and nothing else. Stale notifications get withdrawn.
- A Live Activity (lock screen + Dynamic Island) shows what's happening on a project right now. It may be more
  playful in color/style (think Partiful's live event activity).
- Credentials are requested through the same portal style: OAuth button when available, otherwise a secure
  paste field. Reassure briefly that secrets go to a vault, never into the agent's computer.
- Minimalism. Polish at the level of Airbnb / Uber / Netflix, but simpler and calmer than those apps. No
  decorative noise, no dashboards, no badges for their own sake. Every element earns its place.

## Sample content (use exactly this so directions can be compared)
1. **Lift Log** — iOS app: "A strength log that reads Apple Health and tells me when to add weight."
   Building, day 3. Milestones: Prototype ✓ · Health import ✓ · Progress charts (now) · Rest timer · On your phone.
   Now: "Building progress charts for squat, bench and deadlift."
   Just did: "Apple Health import works in the simulator — 214 workouts from a sample export." (screen recording 0:24)
   Next: "Rest timer with its own Live Activity, then a TestFlight build."
   Needs later: "Your Apple Developer account, around Thursday, to put it on your phone."
2. **Morning Brief** — background worker: "Reads my newsletters overnight and emails me a 5-minute digest at 7."
   Live and maintained. Last: "Sent today's digest at 7:00 — 11 newsletters, 4 min read."
   "Fixed on its own: Substack changed its layout; an alert woke me at 6:12 and the parser was updated before 7."
   Next run: tomorrow 7:00. Needs: nothing.
3. **Cabin** — web app: "A booking site for our family cabin so relatives can claim weekends."
   Exploring. Three prototypes ready for your reaction: "Calendar first", "Requests first", "Rotation".
   Needs you now: pick or react.
4. **Recipe Scaler** — just started, interviewing. Needs you now (question):
   "Who'll use this besides you?"

Question portal example (from a notification), project Cabin:
  "When two relatives want the same weekend, who gets it?"
  TL;DR: "This rule shapes the booking flow and the data model, so I'd rather ask than guess."
  Options: "First to ask" · "Rotate by family branch" · "You approve each request" · Something else (type/talk)
  Meanwhile: "I'll keep building the calendar; only the request step depends on this."

Credential portal example, project Morning Brief:
  "Connect Gmail so I can read your newsletters." Continue with Google. "Read-only. The key stays in Dream's
  vault; the agent's computer only gets temporary access."

Usage awareness example (somewhere natural): "ChatGPT Pro · 62% of this week left" or a paused state:
  "Paused until 3:40 PM — your ChatGPT usage resets then. I'll pick up automatically."

Voice: a live call with the agent ("Talk it through"). While you talk, the foreman listens in and may pass
notes into the call; show this subtly (e.g. "Looking into Apple Health's API…").

## Deliverable
A single self-contained `mocks/<direction>/index.html` (inline CSS/JS; Google Fonts OK; no other network deps,
no build step). Phone screens at 390×844 in device frames.
- On a wide viewport: an overview page with all screens side by side (scrollable), each labeled.
- On a phone-width viewport: a clickable prototype, full-screen, starting at Home, with taps that move between
  screens (home → project → portal etc.) and an obvious way back.
Screens (the first four must be excellent): Home · Project (Lift Log, building) · Question portal (Cabin) ·
Lock screen with Live Activity and one notification · New idea (type or talk, incl. live call state) ·
Prototype reactions (Cabin) · Credential portal (Morning Brief) · Project (Morning Brief, live/maintained) ·
Chat/transcript (one tap away from a project).
Light iOS realism: status bar, home indicator, SF-like type (use Inter or system-ui). Real copy, no lorem ipsum.
