/**
 * The email `EmailAccessLink` sends: what the request is, the link, and how long it works. It carries no key or
 * credential; the link's token is the only thing in it that opens anything, and it works once.
 */
import type { Mail } from "../email/Mailer.ts"

const escape = (text: string): string =>
  text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!)

/** One line, for a subject: the agent's words can run long or hold newlines. */
const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`
}

export const accessEmail = (input: {
  readonly to: string
  /** The card's heading: "Add your Stripe key", "Connect Gmail so I can read your newsletters." */
  readonly heading: string
  readonly project: string
  readonly url: string
  readonly minutes: number
}): Mail => {
  const heading = oneLine(input.heading, 120)
  const project = oneLine(input.project, 80)
  const text = [
    `${heading}`,
    `For ${project}, in Dream.`,
    "",
    "Open this on your computer to finish it there:",
    input.url,
    "",
    `The link works once, for ${input.minutes} minutes. You asked Dream to send it from your phone; if you didn't, don't open it.`
  ].join("\n")
  const html =
    `<!doctype html><html><body style="margin:0;padding:0;background:#0A0A0C">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0A0A0C;padding:32px 16px">` +
    `<tr><td align="center">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#141417;border:1px solid #26262B;border-radius:20px">` +
    `<tr><td style="padding:28px 24px;font-family:Inter,-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif;color:#F5F5F7">` +
    `<p style="margin:0 0 6px;font-size:13px;color:#9A9AA0">${escape(project)}</p>` +
    `<h1 style="margin:0 0 12px;font-size:21px;line-height:1.3;font-weight:650">${escape(heading)}</h1>` +
    `<p style="margin:0 0 22px;font-size:15px;line-height:1.5;color:#B8B8BE">Open this on your computer to finish it there.</p>` +
    `<a href="${escape(input.url)}" style="display:inline-block;padding:13px 22px;border-radius:12px;background:#FFB35C;color:#1B1204;font-size:15px;font-weight:650;text-decoration:none">Open in your browser</a>` +
    `<p style="margin:22px 0 0;font-size:13px;line-height:1.5;color:#7A7A80">The link works once, for ${input.minutes} minutes. ` +
    `You asked Dream to send it from your phone; if you didn't, don't open it.</p>` +
    `</td></tr></table></td></tr></table></body></html>`
  return { to: input.to, subject: heading, text, html }
}
