/**
 * The email `SendEmail` sends: the agent's markdown, rendered into Dream's email (the look of the access-link email,
 * wider for reading), with a plain-text part.
 *
 * The markdown is untrusted. Raw HTML is escaped, never passed through; links go out only as http(s) or mailto, and
 * one whose text isn't its address shows the host it goes to, so a link can't pass for another site. Images become
 * links (nothing loads from the agent's servers when they open it). The frame around it says which project wrote it
 * and that it came from Dream, and nothing in the markdown can change the frame, the sender or the recipient.
 */
import MarkdownIt, { type Token } from "markdown-it"
import type { Mail } from "./Mailer.ts"

const escape = (text: string): string =>
  text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!)

/** One line, for a subject or a project name. */
const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`
}

const font = "Inter,-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Helvetica,Arial,sans-serif"
const mono = "'SF Mono',SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace"

const color = {
  page: "#0A0A0C",
  card: "#141417",
  line: "#26262B",
  code: "#1C1C21",
  title: "#F5F5F7",
  body: "#D9D9DE",
  muted: "#9A9AA0",
  faint: "#7A7A80",
  accent: "#FFB35C"
}

/** Inline styles per element: mail clients drop `<style>` blocks or rewrite them, so every element carries its own. */
const styles: Record<string, string> = {
  p: `margin:0 0 14px;font-size:15.5px;line-height:1.6;color:${color.body}`,
  h1: `margin:26px 0 10px;font-size:19px;line-height:1.35;font-weight:650;color:${color.title}`,
  h2: `margin:24px 0 10px;font-size:17px;line-height:1.35;font-weight:650;color:${color.title}`,
  h3: `margin:20px 0 8px;font-size:15.5px;line-height:1.4;font-weight:650;color:${color.title}`,
  ul: `margin:0 0 14px;padding:0 0 0 22px;font-size:15.5px;line-height:1.6;color:${color.body}`,
  ol: `margin:0 0 14px;padding:0 0 0 24px;font-size:15.5px;line-height:1.6;color:${color.body}`,
  li: "margin:0 0 8px;padding-left:2px",
  blockquote: `margin:0 0 14px;padding:2px 0 2px 14px;border-left:3px solid ${color.line};color:${color.muted}`,
  hr: `border:0;border-top:1px solid ${color.line};margin:22px 0`,
  a: `color:${color.accent};text-decoration:underline;word-break:break-word`,
  strong: `font-weight:650;color:${color.title}`,
  code: `font-family:${mono};font-size:13.5px;background:${color.code};border:1px solid ${color.line};border-radius:6px;padding:1px 5px;color:${color.title}`,
  pre: `margin:0 0 16px;padding:12px 14px;background:${color.code};border:1px solid ${color.line};border-radius:10px;font-family:${mono};font-size:13px;line-height:1.55;color:${color.title};white-space:pre-wrap;word-break:break-word;overflow-x:auto`,
  table: `border-collapse:collapse;margin:0 0 16px;font-size:14.5px;line-height:1.5;color:${color.body}`,
  th: `border:1px solid ${color.line};padding:7px 10px;text-align:left;font-weight:650;color:${color.title}`,
  td: `border:1px solid ${color.line};padding:7px 10px;vertical-align:top;overflow-wrap:anywhere`
}

/** Where a link may go: the web or an address. Anything else (javascript:, data:, file:, relative) stays text. */
const safeUrl = (url: string): boolean => /^(https?:\/\/|mailto:)/i.test(url.trim())

/** What a link's text would have to be for its address to go without saying. */
const bare = (text: string) =>
  text
    .trim()
    .toLowerCase()
    .replace(/^(https?:\/\/|mailto:)/, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "")

/** The host a link goes to, as they'd recognize it ("developer.apple.com"), or its address for mailto. */
const destination = (href: string): string | undefined => {
  if (/^mailto:/i.test(href)) return href.replace(/^mailto:/i, "").split("?")[0]
  try {
    return new URL(href).hostname.replace(/^www\./, "")
  } catch {
    return undefined
  }
}

const textOf = (tokens: ReadonlyArray<Token>, from: number, to: number) =>
  tokens
    .slice(from, to)
    .filter((t) => t.type === "text" || t.type === "code_inline")
    .map((t) => t.content)
    .join("")

const markdown = (() => {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false })
  md.validateLink = safeUrl
  // Fixed-width and fuzzy links ("example.com" with no scheme) aren't worth guessing at.
  md.linkify.set({ fuzzyLink: false, fuzzyEmail: false })

  const rules = md.renderer.rules
  const styled = (tag: string) => (tokens: Array<Token>, idx: number, options: any, _env: any, self: any) => {
    const token = tokens[idx]!
    // A list inside a list item sits close under its line.
    const nested = (tag === "ul" || tag === "ol") && token.level > 0
    token.attrSet("style", nested ? styles[tag]!.replace("margin:0 0 14px", "margin:6px 0 0") : styles[tag]!)
    return self.renderToken(tokens, idx, options)
  }
  for (const [type, tag] of [
    ["paragraph_open", "p"],
    ["bullet_list_open", "ul"],
    ["ordered_list_open", "ol"],
    ["list_item_open", "li"],
    ["blockquote_open", "blockquote"],
    ["hr", "hr"],
    ["strong_open", "strong"],
    ["table_open", "table"],
    ["th_open", "th"],
    ["td_open", "td"]
  ] as const) {
    rules[type] = styled(tag)
  }
  // The subject is the email's only h1; the agent's headings start one level down, from its largest size.
  const level = (token: Token) => Math.min(3, Number(token.tag.slice(1)))
  rules.heading_open = (tokens, idx) => `<h${level(tokens[idx]!) + 1} style="${styles[`h${level(tokens[idx]!)}`]}">`
  rules.heading_close = (tokens, idx) => `</h${level(tokens[idx]!) + 1}>\n`
  rules.code_inline = (tokens, idx) => `<code style="${styles.code}">${escape(tokens[idx]!.content)}</code>`
  const block = (tokens: Array<Token>, idx: number) =>
    `<pre style="${styles.pre}">${escape(tokens[idx]!.content.replace(/\n$/, ""))}</pre>\n`
  rules.fence = block
  rules.code_block = block
  rules.link_open = (tokens, idx, options, _env, self) => {
    const token = tokens[idx]!
    const href = String(token.attrGet("href") ?? "")
    const close = tokens.findIndex((t, i) => i > idx && t.type === "link_close")
    const text = textOf(tokens, idx + 1, close === -1 ? tokens.length : close)
    const host = destination(href)
    // Autolinks and links whose text is their own address say where they go already.
    if (close !== -1 && host !== undefined && bare(text) !== bare(href) && bare(text) !== host.toLowerCase()) {
      tokens[close]!.meta = { host }
    }
    token.attrs = [
      ["href", href],
      ["style", styles.a!],
      ["target", "_blank"],
      ["rel", "noopener noreferrer"]
    ]
    return self.renderToken(tokens, idx, options)
  }
  rules.link_close = (tokens, idx) => {
    const host = (tokens[idx]!.meta as { host?: string } | null)?.host
    return host === undefined
      ? "</a>"
      : `</a> <span style="color:${color.faint};font-size:13px;white-space:nowrap">(${escape(host)})</span>`
  }
  // An image is a link to it, under its alt text: nothing loads from elsewhere when they open the email.
  rules.image = (tokens, idx) => {
    const token = tokens[idx]!
    const src = String(token.attrGet("src") ?? "")
    const alt = textOf(token.children ?? [], 0, token.children?.length ?? 0) || "Image"
    const host = destination(src)
    return `<a href="${escape(src)}" style="${styles.a}" target="_blank" rel="noopener noreferrer">${escape(alt)}</a>${
      host === undefined
        ? ""
        : ` <span style="color:${color.faint};font-size:13px;white-space:nowrap">(image on ${escape(host)})</span>`
    }`
  }
  return md
})()

/** The agent's markdown as email-safe HTML: inline styles, no raw HTML, only safe links. */
export const renderMarkdown = (source: string): string => markdown.render(source)

export const agentEmail = (input: {
  readonly to: string
  readonly subject: string
  readonly markdown: string
  /** The project's title, which the email names as its sender inside Dream. */
  readonly project: string
}): Mail => {
  const subject = oneLine(input.subject, 150)
  const project = oneLine(input.project, 80) || "Your project"
  const footer = `The agent building ${project} wrote this in Dream and sent it to you. To answer it, reply in the Dream app; email replies don't reach it.`
  const text = [subject, `From ${project}, in Dream.`, "", input.markdown.trim(), "", "—", footer].join("\n")
  const html =
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark">` +
    `<title>${escape(subject)}</title>` +
    // Where a client keeps `<style>`, a phone gets narrower margins; elsewhere the inline padding stands.
    `<style>@media (max-width:480px){.pad{padding-left:18px!important;padding-right:18px!important}.page{padding:12px 6px!important}}</style></head>` +
    `<body style="margin:0;padding:0;background:${color.page}">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${color.page}">` +
    `<tr><td align="center" class="page" style="padding:28px 12px">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:${color.card};border:1px solid ${color.line};border-radius:20px">` +
    `<tr><td class="pad" style="padding:28px 26px 8px;font-family:${font};color:${color.title}">` +
    `<p style="margin:0 0 6px;font-size:13px;color:${color.muted}">${escape(project)} · Dream</p>` +
    `<h1 style="margin:0 0 20px;font-size:23px;line-height:1.3;font-weight:650;color:${color.title}">${escape(subject)}</h1>` +
    `<div style="font-family:${font}">${renderMarkdown(input.markdown)}</div>` +
    `</td></tr>` +
    `<tr><td class="pad" style="padding:6px 26px 26px;font-family:${font}">` +
    `<p style="margin:0;padding-top:16px;border-top:1px solid ${color.line};font-size:13px;line-height:1.5;color:${color.faint}">${escape(footer)}</p>` +
    `</td></tr></table></td></tr></table></body></html>`
  return { to: input.to, subject, text, html }
}
