// Renders every screen in screens.html to an iPhone 17 Pro sized PNG (402 × 874 pt at 3× = 1206 × 2622).
// node mocks/screens/app-links/render.cjs [ids…]   (needs playwright; PLAYWRIGHT=/path/to/playwright works too)
const path = require("node:path")
const { chromium } = require(process.env.PLAYWRIGHT || "playwright")
const NAMES = {
  A1: "A1-dock", A2: "A2-dock-empty", A3: "A3-dock-add", A4: "A4-dock-hold",
  B1: "B1-cards", B2: "B2-cards-empty", B3: "B3-cards-add", B4: "B4-cards-hold",
  C1: "C1-chips", C2: "C2-chips-empty", C3: "C3-chips-add", C4: "C4-chips-hold",
  D1: "D1-shelf", D2: "D2-shelf-empty", D3: "D3-shelf-add", D4: "D4-shelf-hold",
  H1: "H1-home-screen-sheet", H2: "H2-safari-hint", H3: "H3-safari-add", H4: "H4-on-home-screen",
  W1: "W1-widget-later"
}
;(async () => {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 3 })
  const ids = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(NAMES)
  const url = "file://" + path.join(__dirname, "screens.html")
  for (const id of ids) {
    await page.goto(`${url}#${id}`)
    await page.reload()
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(150)
    await page.locator(".scr").screenshot({ path: path.join(__dirname, `${NAMES[id]}.png`) })
    console.log(NAMES[id])
  }
  await browser.close()
})()
