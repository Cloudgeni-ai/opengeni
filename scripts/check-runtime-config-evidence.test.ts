import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

const scriptPath = new URL("./check-runtime-config-evidence.ts", import.meta.url).pathname;

describe("runtime config evidence checker", () => {
  it("passes managed staging runtime config evidence", () => {
    const fixture = fixtureDir();
    const out = join(fixture.dir, "runtime-config.json");

    const result = runScript(fixture, out);

    expect(result.status).toBe(0);
    const payload = JSON.parse(readFileSync(out, "utf8"));
    expect(payload.ok).toBe(true);
    expect(payload.checks[0].id).toBe("runtime-config");
    expect(payload.checks[0].metrics.configSecretOverlapAbsent).toBe(true);
  });

  it("fails when a runtime secret overlaps a ConfigMap key", () => {
    const fixture = fixtureDir({ secretKeys: ["OPENGENI_DATABASE_URL", "OPENGENI_OPENAI_REASONING_EFFORT"] });
    const out = join(fixture.dir, "runtime-config.json");

    const result = runScript(fixture, out);

    expect(result.status).not.toBe(0);
    const payload = JSON.parse(readFileSync(out, "utf8"));
    expect(payload.ok).toBe(false);
    expect(payload.checks[0].failures).toContain("runtime secret overlaps configmap key(s): OPENGENI_OPENAI_REASONING_EFFORT");
  });

  it("rejects raw Kubernetes Secret JSON as evidence", () => {
    const fixture = fixtureDir({ rawSecretData: true });
    const out = join(fixture.dir, "runtime-config.json");

    const result = runScript(fixture, out);

    expect(result.status).not.toBe(0);
    const payload = JSON.parse(readFileSync(out, "utf8"));
    expect(payload.checks[0].failures).toContain("runtime secret key evidence must be sanitized; raw Kubernetes Secret data is not accepted");
  });

  it("fails when runtime env still resolves high reasoning", () => {
    const fixture = fixtureDir({ apiReasoningEffort: "high" });
    const out = join(fixture.dir, "runtime-config.json");

    const result = runScript(fixture, out);

    expect(result.status).not.toBe(0);
    const payload = JSON.parse(readFileSync(out, "utf8"));
    expect(payload.checks[0].failures).toContain("runtime env api.OPENGENI_OPENAI_REASONING_EFFORT is high, expected low");
  });
});

function runScript(fixture: ReturnType<typeof fixtureDir>, out: string): ReturnType<typeof spawnSync<string>> {
  return spawnSync("bun", [
    scriptPath,
    "--out", out,
    "--environment", "staging",
    "--base-url", "https://staging.app.opengeni.ai",
    "--client-config-json", fixture.clientConfig,
    "--configmap-json", fixture.configMap,
    "--runtime-secret-keys-json", fixture.secretKeys,
    "--runtime-env-json", fixture.runtimeEnv,
  ], { encoding: "utf8" });
}

function fixtureDir(options: {
  secretKeys?: string[];
  rawSecretData?: boolean;
  apiReasoningEffort?: string;
} = {}): {
  dir: string;
  clientConfig: string;
  configMap: string;
  secretKeys: string;
  runtimeEnv: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "opengeni-runtime-config-"));
  mkdirSync(dir, { recursive: true });
  const clientConfig = join(dir, "client-config.json");
  const configMap = join(dir, "configmap.json");
  const secretKeys = join(dir, "secret-keys.json");
  const runtimeEnv = join(dir, "runtime-env.json");
  writeFileSync(clientConfig, JSON.stringify({
    productAccessMode: "managed",
    defaultReasoningEffort: "low",
    allowedReasoningEfforts: ["low", "medium", "high", "xhigh"],
    auth: { mode: "managedSession" },
  }));
  writeFileSync(configMap, JSON.stringify({
    name: "opengeni-config",
    data: {
      OPENGENI_PRODUCT_ACCESS_MODE: "managed",
      OPENGENI_OPENAI_REASONING_EFFORT: "low",
    },
  }));
  writeFileSync(secretKeys, JSON.stringify(options.rawSecretData
    ? { metadata: { name: "opengeni-runtime" }, data: { OPENGENI_OPENAI_REASONING_EFFORT: "bG93" } }
    : { name: "opengeni-runtime", keys: options.secretKeys ?? ["OPENGENI_DATABASE_URL", "OPENGENI_STRIPE_SECRET_KEY"] }));
  writeFileSync(runtimeEnv, JSON.stringify({
    components: {
      api: { OPENGENI_OPENAI_REASONING_EFFORT: options.apiReasoningEffort ?? "low" },
      worker: { OPENGENI_OPENAI_REASONING_EFFORT: "low" },
    },
  }));
  return { dir, clientConfig, configMap, secretKeys, runtimeEnv };
}
