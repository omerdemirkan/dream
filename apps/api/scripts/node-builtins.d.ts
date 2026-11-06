// Just enough of Node's built-ins for the scripts that run under Node rather than workerd.
declare module "node:child_process" {
  export function execFileSync(
    file: string,
    args: ReadonlyArray<string>,
    options?: {
      readonly stdio?: "inherit" | "pipe"
      readonly encoding?: "utf8"
      readonly env?: Record<string, string | undefined>
    }
  ): string
}

declare module "node:path" {
  export function join(...parts: Array<string>): string
}

declare module "node:url" {
  export function fileURLToPath(url: URL | string): string
}
