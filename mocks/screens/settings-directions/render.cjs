// Renders every screen in screens.html to a PNG at 3× (393 × 852 pt → 1179 × 2556).
// node mocks/screens/settings-directions/render.cjs [ids…]   (needs playwright; PLAYWRIGHT=/path/to/playwright works too)
const path = require("node:path")
const { chromium } = require(process.env.PLAYWRIGHT || "playwright")
const NAMES = {
  A1: "A1-settings", A2: "A2-subscription", A3: "A3-dream-usage", A4: "A4-service", A5: "A5-bottom", A6: "A6-states",
  B1: "B1-settings", B2: "B2-subscription", B3: "B3-dream-usage", B4: "B4-service", B5: "B5-archived", B6: "B6-states",
  C1: "C1-settings", C2: "C2-subscription", C3: "C3-dream-usage", C4: "C4-service", C5: "C5-bottom", C6: "C6-states"
}
;(async () => {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 3 })
  await page.goto("file://" + path.join(__dirname, "screens.html"))
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(300)
  const ids = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(NAMES)
  for (const id of ids) {
    await page.locator(`#${id}`).screenshot({ path: path.join(__dirname, `${NAMES[id]}.png`) })
    console.log(NAMES[id])
  }
  await browser.close()
})()
