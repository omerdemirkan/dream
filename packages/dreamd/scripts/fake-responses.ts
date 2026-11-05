/**
 * A stand-in for the ChatGPT backend's Responses API, for running Codex turns
 * without a ChatGPT account. Every request gets the reply "hi there" with
 * rate-limit headers (five-hour window 42.5% used, weekly 12%), or, with
 * MODE=limit, a 429 usage-limit error with the five-hour window full.
 *
 *   MODE=ok|limit node packages/dreamd/scripts/fake-responses.ts [port]     (default 18788)
 *
 * Point dreamd at it with DREAM_CODEX_BASE_URL=http://127.0.0.1:<port>/backend-api/codex.
 * It prints each request's path and Authorization header.
 */
import { createServer } from "node:http"

const port = Number(process.argv[2] ?? 18788)
const mode = process.env.MODE === "limit" ? "limit" : "ok"

const rateLimits = () => {
  const now = Math.floor(Date.now() / 1000)
  return {
    "x-codex-primary-used-percent": mode === "limit" ? "100" : "42.5",
    "x-codex-primary-window-minutes": "300",
    "x-codex-primary-reset-at": String(now + 3600),
    "x-codex-secondary-used-percent": "12",
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-reset-at": String(now + 5 * 86400)
  }
}

const sse = (events: ReadonlyArray<{ readonly type: string; readonly [key: string]: unknown }>) =>
  events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")

createServer((request, response) => {
  request.resume()
  request.on("end", () => {
    console.log(
      JSON.stringify({ method: request.method, url: request.url, authorization: request.headers.authorization })
    )
    if (request.url?.endsWith("/responses") !== true) {
      response.writeHead(404).end()
    } else if (mode === "limit") {
      response.writeHead(429, { "content-type": "application/json", ...rateLimits() })
      response.end(
        JSON.stringify({
          error: {
            type: "usage_limit_reached",
            message: "limit",
            plan_type: "pro",
            resets_at: Math.floor(Date.now() / 1000) + 3600
          }
        })
      )
    } else {
      response.writeHead(200, { "content-type": "text/event-stream", ...rateLimits() })
      response.end(
        sse([
          { type: "response.created", response: { id: "resp_1" } },
          {
            type: "response.output_item.done",
            item: {
              type: "message",
              role: "assistant",
              id: "msg_1",
              content: [{ type: "output_text", text: "hi there" }]
            }
          },
          {
            type: "response.completed",
            response: {
              id: "resp_1",
              usage: {
                input_tokens: 10,
                input_tokens_details: { cached_tokens: 0 },
                output_tokens: 2,
                output_tokens_details: { reasoning_tokens: 0 },
                total_tokens: 12
              }
            }
          }
        ])
      )
    }
  })
}).listen(port, "127.0.0.1", () => console.log(`fake Responses API (${mode}) on http://127.0.0.1:${port}`))
