---
covers: "`dream link`: the row of app icons on their Home, what a tile shows, their edits, Add to Home Screen, and sharing."
---

# App links on their Home

The first thing on their Home, under the Dream header and above their projects, is a row of app icons, like a second
dock: rounded tiles with a short label under each, and an Add tile at the end. About five fit across before the row
scrolls, and all their projects share it, since only agents put links there. So a link is for something they'll open
again and again, like the app itself or a page they check every morning, not for each page or each update. A project
gets three at most. A tap opens the page full screen inside Dream.

- `dream link add <url> --title … --icon … --color …` puts one at the end of the row, usually your published URL or a
  page on it.
  - The title is the label: one line of small type under the tile. About ten characters show, and a longer title is
    cut short with "…".
  - The tile is an SF Symbol or an emoji on one of ten colours, or a square png or jpg of yours (at least 180 px)
    that fills it edge to edge, since iOS rounds the corners. Without `--icon` it shows the title's first letter. It
    sits among icons like their real apps', where one clear glyph reads best.
  - Until they first open it, a small dot sits before the label, as on a newly installed app.
  - That's all the row shows. Holding a tile lifts it and opens a menu headed "Made by" and this project's name, over
    the link's host, with Open, Share, Add to Home Screen, Rename, Change icon and Remove.
  - Every `dream link` command prints what they'll see: the label as it shows, the tile, and the menu's header.
- They can rename a link, change its icon to a symbol or emoji and a colour, or remove it, and you get an event when
  they do. What they changed stays theirs: `dream link update` can't change it back, and this project can't add a URL
  they removed again. Only they can put a removed one back, from the Add tile, and then it's yours to update again.
  `dream link list` shows each link and what they've done with it.
- Add to Home Screen puts a link on their iPhone's own Home Screen, through Safari, as a web app that opens full
  screen. For your published URL, Dream gives Safari the link's title and tile, so they become your app's name and
  icon on their phone. A link to another site gets that site's own name and icon.
- Share sends the link through Messages, WhatsApp, Mail and the like, and the preview the recipient sees comes from
  the page's Open Graph tags. Where your published page sets no `og:title` or `og:image`, Dream uses the link's title
  and tile, so set your own only when you have better, such as a 1200×630 image of the app, with `og:description`.
- An archived project's links leave their Home until it's restored, and a deleted project's links go with it.
