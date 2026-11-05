// Load a URL in Playwright's Chromium and print what happened as one line of
// JSON, for `dream publish` (see PageCheck.ts, which decodes it). Plain
// CommonJS so it can require the globally installed Playwright, which the
// dreamd package doesn't declare.
//
//   node load-page.cjs <url> <timeout-ms>
"use strict"
const path = require("node:path")

const [url, timeoutArg] = process.argv.slice(2)
const timeout = Number(timeoutArg) || 10_000
const print = (result) => process.stdout.write(`${JSON.stringify(result)}\n`)

const loadPlaywright = () => {
  const paths = [
    path.join(path.dirname(process.execPath), "..", "lib", "node_modules"),
    ...(process.env.NODE_PATH ?? "").split(path.delimiter).filter(Boolean)
  ]
  return require(require.resolve("playwright", { paths }))
}

const firstLine = (text) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0)

const main = async () => {
  let playwright
  try {
    playwright = loadPlaywright()
  } catch {
    return print({ _tag: "Unavailable", reason: "Playwright isn't installed" })
  }
  let browser
  try {
    browser = await playwright.chromium.launch({ args: ["--no-sandbox"] })
  } catch (error) {
    return print({ _tag: "Unavailable", reason: `Chromium didn't start: ${firstLine(String(error.message))}` })
  }
  const deadline = Date.now() + timeout
  const remaining = () => Math.max(1, deadline - Date.now())
  try {
    const page = await browser.newPage()
    const pageErrors = []
    const consoleErrors = []
    const failedRequests = []
    const isDocument = (request) => request.isNavigationRequest() && request.frame() === page.mainFrame()
    page.on("pageerror", (error) => pageErrors.push(error.name ? `${error.name}: ${error.message}` : String(error)))
    page.on("console", (message) => {
      // Failed subresources show up as console errors too; they're reported once, as requests.
      if (message.type() === "error" && !message.text().startsWith("Failed to load resource"))
        consoleErrors.push(message.text())
    })
    // A subresource that answered 4xx/5xx is often aborted afterwards too; it's reported once, with its status.
    const answeredBadly = new Set()
    page.on("response", (response) => {
      if (response.status() >= 400 && !isDocument(response.request())) {
        answeredBadly.add(response.url())
        failedRequests.push(`${response.status()} ${response.url()}`)
      }
    })
    page.on("requestfailed", (request) => {
      if (!isDocument(request) && !answeredBadly.has(request.url()))
        failedRequests.push(`${request.failure()?.errorText ?? "failed"} ${request.url()}`)
    })
    let response
    try {
      response = await page.goto(url, { waitUntil: "commit", timeout: remaining() })
    } catch (error) {
      return print({ _tag: "Unreachable", via: "browser", message: firstLine(String(error.message)) ?? "failed" })
    }
    let stillLoading = false
    try {
      await page.waitForLoadState("load", { timeout: remaining() })
      // Apps often fetch data after load and fail rendering it, so give them until the network settles.
      await page.waitForLoadState("networkidle", { timeout: remaining() })
    } catch {
      stillLoading = page.url() === "about:blank" || (await page.evaluate(() => document.readyState)) !== "complete"
    }
    const title = await page.title().catch(() => "")
    const text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "")
    // Vite's overlay for build errors lives in a shadow root, so innerText misses it.
    const overlay = await page
      .evaluate(() => document.querySelector("vite-error-overlay")?.shadowRoot?.querySelector(".message")?.textContent)
      .catch(() => undefined)
    if (overlay) pageErrors.unshift(`Vite error overlay: ${overlay}`)
    const contentType = response?.headers()["content-type"]
    const line = firstLine(text)
    print({
      _tag: "Loaded",
      via: "browser",
      status: response?.status() ?? 0,
      ...(contentType ? { contentType } : {}),
      ...(title.trim() ? { title: title.trim() } : {}),
      ...(line ? { firstLine: line } : {}),
      pageErrors,
      consoleErrors,
      failedRequests,
      stillLoading
    })
  } finally {
    await browser.close().catch(() => {})
  }
}

main().catch((error) => print({ _tag: "Unavailable", reason: firstLine(String(error?.message ?? error)) ?? "failed" }))
