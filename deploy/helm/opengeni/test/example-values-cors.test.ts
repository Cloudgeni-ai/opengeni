import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const chart = resolve(import.meta.dir, "..");

// OPENGENI_CORS_ALLOW_ORIGIN_REGEX lists the origins that may send browser
// cookies to the API cross-origin. A self-hoster copies these example files,
// so none may name an origin OpenGeni operates (or localhost): that would
// grant it credentialed CORS to their deployment.
test("shipped values grant credentialed CORS only to placeholder origins", async () => {
  const files = (await readdir(chart)).filter((name) => /^values(\..+)?\.ya?ml$/u.test(name));
  expect(files).toContain("values.azure-managed.example.yaml");
  for (const file of files) {
    const values = Bun.YAML.parse(await readFile(resolve(chart, file), "utf8")) as {
      config?: Record<string, unknown>;
    };
    const pattern = values?.config?.OPENGENI_CORS_ALLOW_ORIGIN_REGEX;
    if (pattern === undefined || pattern === "") continue;
    expect(typeof pattern).toBe("string");
    // Mirrors the API's anchored match (apps/api/src/http/cors.ts).
    const allowed = (origin: string) => new RegExp(`^(?:${pattern as string})$`).test(origin);
    for (const origin of [
      "https://app.opengeni.ai",
      "https://staging.app.opengeni.ai",
      "https://geni-staging.app.opengeni.ai",
      "http://localhost:3000",
      "http://127.0.0.1:5173",
    ]) {
      expect({ file, origin, allowed: allowed(origin) }).toEqual({ file, origin, allowed: false });
    }
  }
});
