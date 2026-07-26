import { defineConfig } from "tsup";

// @opengeni/sdk ships ESM + .d.ts with ZERO runtime dependencies. It hand-mirrors
// the contracts wire types in src/types.ts (pinned by test/contract-parity.test.ts),
// so nothing — neither @opengeni/contracts nor any server-internal package — is
// bundled or imported at runtime. Do NOT add runtime deps or zod here.
//
// Every @opengeni/* specifier is marked external. The SDK legitimately has zero
// @opengeni runtime imports, so this is normally a no-op — but it is load-bearing
// for the publish closure guard: if a stray `import "@opengeni/<server>"` ever
// sneaks in, externalizing keeps the literal specifier in dist/index.js (instead
// of esbuild silently inlining the server package and erasing the specifier the
// guard greps for), so the guard catches the leak instead of shipping it.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2022",
  dts: true,
  sourcemap: true,
  clean: true,
  external: [/^@opengeni\//],
});
