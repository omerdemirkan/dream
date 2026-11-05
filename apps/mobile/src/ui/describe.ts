/**
 * Words for access requests and integrations, derived from what the agent
 * asked for: which Google product, what the scopes allow, when it's needed.
 */
import type { AccessMessage, AccessRequest, Integration } from "@dream/domain"

const googleProducts: ReadonlyArray<readonly [string, string]> = [
  ["gmail", "Gmail"],
  ["calendar", "Google Calendar"],
  ["drive", "Google Drive"],
  ["spreadsheets", "Google Sheets"],
  ["sheets", "Google Sheets"],
  ["documents", "Google Docs"],
  ["docs", "Google Docs"],
  ["youtube", "YouTube"],
  ["photos", "Google Photos"],
  ["contacts", "Google Contacts"],
  ["tasks", "Google Tasks"]
]

const scopeWords: Record<string, string> = {
  "gmail.readonly": "Read-only.",
  "gmail.send": "Can send email.",
  "gmail.compose": "Can draft and send email.",
  "gmail.modify": "Can read and organize email.",
  "calendar.events": "Calendar events only.",
  "calendar.readonly": "Read-only calendar.",
  calendar: "Full calendar access.",
  "drive.readonly": "Read-only Drive.",
  "drive.file": "Only files it creates.",
  "spreadsheets.readonly": "Read-only Sheets.",
  spreadsheets: "Sheets it can edit.",
  "documents.readonly": "Read-only Docs.",
  "contacts.readonly": "Read-only contacts."
}

export const googleLabel = (scopes: ReadonlyArray<string>) => {
  const products = new Set<string>()
  for (const scope of scopes) {
    const product = googleProducts.find(([prefix]) => scope.toLowerCase().startsWith(prefix))
    if (product) products.add(product[1])
  }
  return products.size === 1 ? (Array.from(products)[0] ?? "Google") : "Google"
}

/** "Calendar events only." / "Read-only." — absent when the scopes say nothing a person cares about. */
export const scopeSummary = (scopes: ReadonlyArray<string>) => {
  const words = scopes.map((scope) => scopeWords[scope]).filter((w): w is string => w !== undefined)
  return words.length > 0 ? words.join(" ") : undefined
}

export const accessLabel = (request: AccessRequest) => {
  switch (request._tag) {
    case "Google":
      return googleLabel(request.scopes)
    case "Key":
      return request.service
    case "Apple":
      return "Apple Developer"
  }
}

/** The line under the heading: how the access works. */
export const accessExplainer = (message: AccessMessage) => {
  const request = message.request
  switch (request._tag) {
    case "Google":
      return `You'll sign in with Google and approve ${googleLabel(request.scopes)}.`
    case "Key":
      return `${request.service} has no sign-in for this, so it takes an API key. Dream adds it to requests to ${request.host}.`
    case "Apple":
      return message.when
        ? `Apple has no sign-in for this, so it takes an App Store Connect key. Add it now, or I'll ask again ${message.when}.`
        : "Apple has no sign-in for this, so it takes an App Store Connect key (issuer ID, key ID and the .p8 file)."
  }
}

export const accessScope = (request: AccessRequest) =>
  request._tag === "Google" ? scopeSummary(request.scopes) : undefined

export const isOAuth = (request: AccessRequest) => request._tag === "Google"

/** "around Thursday" → "Needed around Thursday". */
export const whenTag = (when: string) => {
  const trimmed = when.trim()
  return /^needed\b/i.test(trimmed) ? trimmed : `Needed ${trimmed}`
}

export const integrationSummary = (integration: Integration) => {
  const access = integration.access
  switch (access._tag) {
    case "Google":
      return [scopeSummary(access.scopes), access.email].filter(Boolean).join(" ") || "Google account"
    case "Key":
      return `Key for ${access.host}`
    case "Apple":
      return `App Store Connect key ${access.keyId}`
  }
}
