import { defineConfig } from "tsup";

// @opengeni/db ships ESM + .d.ts with four entry points mirroring the committed
// src subpaths the workspace already uses:
//   .                 -> src/index.ts          (the full db surface; re-exports migrate + provisionRoles)
//   ./schema          -> src/schema.ts         (drizzle table defs; @opengeni/documents imports this)
//   ./migrate         -> src/migrate.ts        (the SQL migration runner; tests + db:migrate use it)
//   ./provision-roles -> src/provision-roles.ts (the role/grant provisioner SDK entry + CLI)
//
// Every subpath in package.json `exports` must have a matching entry here:
// rewrite-entry-points.ts swaps every committed `./src/<name>.ts` export target
// to `./dist/<name>.js` at publish time, so a missing entry would publish a
// dangling export.
//
// migrate.ts resolves the SQL files via `new URL("../drizzle", import.meta.url)`.
// That relative path (`../drizzle`) is identical from src/ and dist/, so the
// bundled dist/migrate.js finds packages/db/drizzle as long as the published
// tarball ships the drizzle/ dir (see `files` in package.json). tsup preserves
// import.meta.url for the ESM target, so the lookup keeps working.
//
// Every @opengeni/* specifier is externalized so the published siblings
// (@opengeni/contracts, @opengeni/config) are resolved by the consumer rather
// than inlined. drizzle-orm and postgres stay normal runtime deps, externalized.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    schema: "src/schema.ts",
    migrate: "src/migrate.ts",
    "provision-roles": "src/provision-roles.ts",
  },
  format: ["esm"],
  target: "es2022",
  dts: true,
  sourcemap: true,
  clean: true,
  external: [/^@opengeni\//],
});
