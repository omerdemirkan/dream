// Just enough of Node's built-in SQLite for the D1 and DO-storage shims.
declare module "node:sqlite" {
  export class StatementSync {
    all(...params: ReadonlyArray<unknown>): Array<Record<string, unknown>>
    run(...params: ReadonlyArray<unknown>): { changes: number | bigint; lastInsertRowid: number | bigint }
    columns(): Array<{ name: string }>
    setReturnArrays(enabled: boolean): void
  }
  export class DatabaseSync {
    constructor(path: string)
    prepare(sql: string): StatementSync
    exec(sql: string): void
    close(): void
  }
}

declare module "node:fs" {
  export function readFileSync(path: URL, encoding: "utf8"): string
  export function readdirSync(path: URL): Array<string>
}
