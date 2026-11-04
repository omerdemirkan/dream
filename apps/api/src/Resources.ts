/**
 * Cloudflare resources the Worker binds. Declaring them here, next to the code
 * that uses them, is the alchemy v2 pattern: binding one in the Worker deploys
 * the wiring with it.
 */
import * as Cloudflare from "@alchemy.run/cloudflare"

/**
 * Global relational state: users, invites, devices, model connections,
 * integrations, projects, open asks (for Home), usage ledger. Migrations are
 * plain .sql files in apps/api/migrations, applied in order on deploy.
 * (Alchemy runs from the workspace root, so non-entry paths are root-relative.)
 */
export const Database = Cloudflare.D1.Database("Database", {
  migrations: "apps/api/migrations"
})

/** Screenshots and screen recordings (`MediaRef`). Private; served through the Worker. */
export const Media = Cloudflare.R2.Bucket("Media")
