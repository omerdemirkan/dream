/**
 * In-memory stand-ins for the two SQLite bindings the control plane uses,
 * backed by Node's built-in SQLite: a D1Database (for @effect/sql-d1) and a
 * Durable Object storage with `sql` (for @effect/sql-sqlite-do). They run the
 * real migrations and the real queries.
 */
import { readFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

const normalize = (value: unknown) =>
  typeof value === "boolean" ? (value ? 1 : 0) : value === undefined ? null : value

export const makeD1 = (migrationsDir = new URL("../../migrations/", import.meta.url)) => {
  const db = new DatabaseSync(":memory:")
  db.exec("PRAGMA foreign_keys = ON")
  db.exec(readFileSync(new URL("0001_init.sql", migrationsDir), "utf8"))
  const statement = (sql: string, params: ReadonlyArray<unknown>) => {
    const run = () => {
      const stmt = db.prepare(sql)
      return { stmt, rows: stmt.all(...params.map(normalize)) }
    }
    return {
      bind: (...next: ReadonlyArray<unknown>) => statement(sql, next),
      all: async () => ({ results: run().rows, success: true, meta: {} }),
      raw: async () => {
        const stmt = db.prepare(sql)
        stmt.setReturnArrays(true)
        return stmt.all(...params.map(normalize))
      },
      run: async () => ({ results: run().rows, success: true, meta: {} }),
      first: async () => run().rows[0] ?? null
    }
  }
  const d1 = {
    prepare: (sql: string) => statement(sql, []),
    batch: async (statements: Array<{ all: () => Promise<unknown> }>) => {
      const out = []
      for (const s of statements) out.push(await s.all())
      return out
    },
    exec: async (sql: string) => {
      db.exec(sql)
      return { count: 1, duration: 0 }
    }
  }
  return { d1: d1 as any, db }
}

export const makeDoStorage = () => {
  const db = new DatabaseSync(":memory:")
  const alarms: Array<number | null> = []
  const sql = {
    exec: (query: string, ...params: ReadonlyArray<unknown>) => {
      const stmt = db.prepare(query)
      stmt.setReturnArrays(true)
      const rows = stmt.all(...params.map(normalize)) as unknown as Array<Array<unknown>>
      const columnNames = stmt.columns().map((column) => column.name)
      return {
        columnNames,
        raw: () => rows[Symbol.iterator](),
        toArray: () => rows.map((row) => Object.fromEntries(columnNames.map((name, i) => [name, row[i]]))),
        rowsRead: rows.length,
        rowsWritten: 0
      }
    }
  }
  let depth = 0
  const storage = {
    sql,
    transaction: async <T>(closure: (txn: unknown) => Promise<T>) => {
      const name = `sp${depth++}`
      db.exec(`SAVEPOINT ${name}`)
      try {
        const result = await closure({ rollback: () => db.exec(`ROLLBACK TO ${name}`) })
        db.exec(`RELEASE ${name}`)
        return result
      } catch (error) {
        db.exec(`ROLLBACK TO ${name}`)
        db.exec(`RELEASE ${name}`)
        throw error
      } finally {
        depth--
      }
    },
    transactionSync: <T>(closure: () => T) => {
      db.exec("BEGIN")
      try {
        const result = closure()
        db.exec("COMMIT")
        return result
      } catch (error) {
        db.exec("ROLLBACK")
        throw error
      }
    },
    setAlarm: async (at: number) => void alarms.push(at),
    deleteAlarm: async () => void alarms.push(null)
  }
  return { storage: storage as any, db, alarms }
}
