// workerd provides `import.meta.url`; @cloudflare/workers-types doesn't declare it.
// Alchemy uses it to find each Worker's entry (`main: import.meta.url`).
interface ImportMeta {
  readonly url: string
}
