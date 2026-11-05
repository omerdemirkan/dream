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
  // Pinned so a deploy from a machine without alchemy state adopts the live database (`--adopt` matches by
  // name) instead of creating an empty one with a random suffix. This is the database created on the first deploy.
  name: "Dream-Database-prod-kccyzam25lk62vk7",
  migrations: "apps/api/migrations"
})

/** Screenshots and screen recordings (`MediaRef`). Private; served through the Worker. */
export const Media = Cloudflare.R2.Bucket("Media", {
  // Pinned for the same reason as the database: stateless deploys must adopt, not recreate.
  name: "dream-media"
})

/**
 * Over-the-air update bundles and assets of the iPhone app, by content hash (`assets/<hash>`). Private; the Worker
 * serves them at `/updates/assets/:hash`.
 */
export const Updates = Cloudflare.R2.Bucket("Updates", {
  name: "dream-updates"
})
