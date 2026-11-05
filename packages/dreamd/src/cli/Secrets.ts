/**
 * Spotting a `dream ask` that asks the person for a credential. Their answer
 * is shown in Chat and delivered to this sandbox, so a secret must come
 * through `dream access` instead, where Dream stores it and the sandbox only
 * ever sees a placeholder.
 *
 * Credential words alone aren't enough, because a question about the app being
 * built ("Should users sign in with a password or a magic link?") is fine. A
 * question is refused when a credential appears together with a sign that the
 * person is being asked to hand one over: a possessive or "what's the" right
 * before it ("your bot token"), or a request to paste, provide, share, copy… it.
 */
import { Option } from "effect"

const sep = String.raw`[\s_-]?`

/** Kinds of credential. Bare "secret" and "key" mean too many other things to count on their own. */
const credential = new RegExp(
  String.raw`\b(?:` +
    [
      String.raw`(?:personal${sep}access|access|bot|api|auth|authentication|bearer|refresh|session|oauth|id|secret|developer|integration|app)${sep}tokens?`,
      String.raw`tokens?`,
      String.raw`api${sep}keys?`,
      String.raw`(?:secret${sep}(?:access${sep})?|access${sep}|private${sep}|signing${sep}|ssh${sep})keys?`,
      String.raw`(?:client|app|application|api|consumer|webhook|signing|shared|oauth|jwt|bot)${sep}secrets?`,
      String.raw`pass${sep}words?|passwd|passphrases?|passcodes?`,
      String.raw`(?:auth|authorization|verification|one${sep}time|2fa|mfa|otp|totp|security|recovery|backup|login)${sep}codes?`,
      String.raw`(?:seed|recovery)${sep}phrases?`,
      String.raw`credentials?|creds`,
      String.raw`connection${sep}strings?`
    ].join("|") +
    String.raw`)\b`,
  "g"
)

/** Words that turn a credential word into a design topic: "password reset", "token limit", "API key rotation". */
const notTheCredential =
  /^\s*(?:length|resets?|managers?|policy|policies|strength|requirements?|rules?|fields?|inputs?|forms?|hash(?:ing|es)?|storage|logins?|auth|authentication|based|rotation|expiry|expiration|limits?|counts?|usage|budgets?|windows?|prices?|balances?|symbols?|supply|holders|standards?|gated|sales?|scopes?|permissions?|validation|protected|protection|less|free|vaults?|generators?|flows?|screens?|pages?)\b/

/** Tokens that aren't credentials at all. */
const notACredentialToken =
  /\b(?:design|max|maximum|output|input|context|erc-?\d+|crypto|nft|game|csrf|lexer|parser)\s+$/

/** The person is being asked to hand something over (not "users enter a password", which is about the app). */
const asking =
  /(?<!\b(?:users?|customers?|people|visitors|members|they|someone|anyone)\s+(?:can\s+|could\s+|should\s+|will\s+|must\s+|to\s+)?)\b(?:paste|pasting|provide|providing|share|sharing|send|sending|give|giving|enter|entering|copy|copying|supply|submit|forward|reply with|type in|drop in|do you have|have you got|can i have|could i have|can i get|could i get|i(?:'ll| will)? need)\b/

/**
 * "your Discord bot token", "what's the password": the credential is theirs, or
 * is being asked for, within a few words. The words between must read as a
 * name ("your Discord bot"), not a clause ("your app accepts API keys").
 */
const theirs = /\b(?:your|yours|my|our|what(?:'s| is| are) (?:the|your))\s+((?:\S+\s+){0,3})$/

const clauseWords =
  /\b(?:use|uses|using|accept|accepts|support|supports|require|requires|need|needs|store|stores|have|has|issue|issues|generate|generates|check|checks|validate|validates|rotate|rotates|show|shows|hide|hides|send|sends|be|is|are|should|will|can|could|to|or|and|with|without|by|for|best|way)\b/

const isTheirs = (before: string) => {
  const match = theirs.exec(before)
  return match !== null && !clauseWords.test(match[1] ?? "")
}

/** Lowercased, with markdown emphasis and code marks gone, so "**Bot Token**" reads as "bot token". */
const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[*_`#>]+/g, " ")
    .replace(/[’]/g, "'")
    .replace(/\s+/g, " ")

/**
 * The credential a question asks the person for, if it asks for one: the
 * matched words, for the refusal. `texts` are the question, `--why` and the
 * options, taken together.
 */
export const requestedSecret = (texts: ReadonlyArray<string>): Option.Option<string> => {
  const text = normalize(texts.join("\n"))
  const asks = asking.test(text)
  for (const match of text.matchAll(credential)) {
    const before = text.slice(0, match.index)
    const after = text.slice(match.index + match[0].length)
    if (notTheCredential.test(after)) continue
    if (/^tokens?$/.test(match[0]) && notACredentialToken.test(before)) continue
    if (asks || isTheirs(before)) return Option.some(match[0])
  }
  return Option.none()
}

/** Why `dream ask` won't send it, and what to run instead. */
export const refusal = (secret: string) =>
  [
    `Not sent: this asks them for a secret ("${secret}"). Answers to \`dream ask\` are visible in Chat and arrive in this sandbox, so a typed-in secret leaks.`,
    "Ask for it with `dream access key`; they paste it into Dream, and Dream adds it to your HTTPS requests to --host:",
    `  dream access key --service Discord --host discord.com --header Authorization --format "Bot {key}" --why "Post quotes to your channel"`,
    "Google sign-in is `dream access google --scopes …`; other OAuth sign-ins (Spotify, GitHub, Strava, Dropbox, Slack, Notion, …) are `dream access oauth <provider>`; App Store Connect is `dream access apple`.",
    "Only if it can't go in a header (a URL path, a login payload, SMTP), `dream access file` puts it in a file here.",
    "If it isn't a credential (e.g. you're asking how the app's own login should work), run it again with --not-a-secret."
  ].join("\n")
