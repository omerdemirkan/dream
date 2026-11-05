/**
 * Words for access requests and integrations, derived from what the agent
 * asked for: which Google product, what the scopes allow, when it's needed.
 */
import type { AccessMessage, AccessRequest, Integration, ProjectId } from "@dream/domain"

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
    case "File":
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
    case "File":
      return `${request.service} needs the key itself, in a way Dream can’t add for it, so Dream puts it in a file on this project’s computer.`
    case "Apple":
      return message.when
        ? `Apple has no sign-in for this, so it takes an App Store Connect key. Add it now, or I'll ask again ${message.when}.`
        : "Apple has no sign-in for this, so it takes an App Store Connect key (issuer ID, key ID and the .p8 file)."
  }
}

export const accessScope = (request: AccessRequest) =>
  request._tag === "Google" ? scopeSummary(request.scopes) : undefined

export const isOAuth = (request: AccessRequest) => request._tag === "Google"

/** A key Dream writes into the project's sandbox (`dream access file`): the last resort, which the card warns about. */
export const isKeyFile = (request: AccessRequest) => request._tag === "File"

export const keyFileWarning =
  "Last resort: the key will live on this project’s computer, where any code running there can read it."

/** Who gets what they connected: everyone, or for a key file, only the project that asked. */
export const accessReach = (request: AccessRequest) =>
  isKeyFile(request) ? "Only on this project’s computer" : "Shared with all your projects"

/** "around Thursday" → "Needed ~Thursday", short enough for a tag. */
export const whenTag = (when: string) => {
  const trimmed = when.trim().replace(/^(around|about|roughly)\s+/i, "~")
  return /^needed\b/i.test(trimmed) ? trimmed : `Needed ${trimmed}`
}

export const integrationSummary = (integration: Integration) => {
  const access = integration.access
  switch (access._tag) {
    case "Google":
      return [scopeSummary(access.scopes), access.email].filter(Boolean).join(" ") || "Google account"
    case "Key":
      return `Key for ${access.host}`
    case "File":
      return "Key file on one project’s computer"
    case "Apple":
      return `App Store Connect key ${access.keyId}`
  }
}

/** Settings' second line for an integration: what it is, and which projects have it. */
export const integrationReach = (integration: Integration, projectTitle: (id: ProjectId) => string | undefined) =>
  integration.access._tag === "File"
    ? `Key file on ${projectTitle(integration.access.projectId) ?? "one project"}’s computer · only that project`
    : `${integrationSummary(integration)} · shared by all your projects`
