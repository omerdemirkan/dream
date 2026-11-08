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

  export interface ChildProcess {
    readonly stdout: { on(event: "data", listener: (chunk: Uint8Array | string) => void): void }
    readonly stderr: { on(event: "data", listener: (chunk: Uint8Array | string) => void): void }
    on(event: "close", listener: (code: number | null) => void): void
    kill(signal?: string): boolean
  }
  export function spawn(
    command: string,
    args: ReadonlyArray<string>,
    options?: { readonly stdio?: "ignore" | ReadonlyArray<"ignore" | "pipe" | "inherit"> }
  ): ChildProcess
}

declare module "node:fs" {
  export function mkdtempSync(prefix: string): string
  export function writeFileSync(path: string, data: string, options: { readonly mode?: number }): void
}

declare module "node:os" {
  export function tmpdir(): string
}

declare module "node:path" {
  export function join(...parts: Array<string>): string
}

declare module "node:url" {
  export function fileURLToPath(url: URL | string): string
}

declare module "node:http" {
  export interface IncomingMessage extends AsyncIterable<Uint8Array> {
    readonly method?: string
    readonly url?: string
    readonly headers: Record<string, string | ReadonlyArray<string> | undefined>
  }
  export interface ServerResponse {
    writeHead(status: number, headers: Record<string, string>): void
    end(body?: Uint8Array): void
  }
  export function createServer(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>): {
    listen(port: number, host: string, callback?: () => void): void
  }
}
