import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import {
  run,
  type Configuration,
  type Dependencies,
} from "../docs/merge-batcher-admin/minimal-watchdog-provider";
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
function fixture() {
  const config: Configuration = {
    service: "projects/cloudgeni-gecko/locations/europe-west1/services/batcher",
    adminDirectory: "/work/admin",
    claimBucket: "fixture-bucket",
    activationId: "11111111-1111-4111-8111-111111111111",
    planSha256: sha("plan"),
    claimObject: "",
  };
  config.claimObject = `minimal-watchdog/${config.activationId}/${config.planSha256}/claim`;
  const target = {
    uid: "uid",
    image: `registry/image@sha256:${"a".repeat(64)}`,
    uri: "https://batcher.example.run.app",
  };
  const sources = Object.fromEntries(
    [
      "control.ts",
      "cloud-auth.ts",
      "service-config.ts",
      "service-limits.ts",
      "stopped-reconciliation.ts",
      "stopped-lineage.ts",
    ].map((x) => [x, sha(x)]),
  );
  const calls: string[] = [],
    events: unknown[] = [];
  const deps: Dependencies = {
    read: async (path) =>
      path.endsWith("plan.json")
        ? "plan"
        : path.endsWith("stop-contract.json")
          ? JSON.stringify({
              schemaVersion: 1,
              directory: "/work/operator",
              deployment: target,
              sources,
            })
          : path.split("/").at(-1)!,
    loadCloud: async () => ({
      identityToken: async (audience) => {
        expect(audience).toBe(target.uri);
        return "secret-test-token";
      },
      api: async (_url, method = "GET") => {
        calls.push(method);
        if (method !== "GET") throw Error("Provider writes forbidden");
        return {
          ...target,
          generation: "27",
          observedGeneration: "27",
          template: { containers: [{ image: target.image }] },
        };
      },
    }),
    request: (async (_url, init) => {
      expect((init?.headers as Record<string, string>)?.Authorization).toBe(
        "Bearer secret-test-token",
      );
      return Response.json({ state: "stopped" });
    }) as typeof fetch,
    now: () => 2_000_000,
    record: (event) => {
      events.push(event);
    },
  };
  return { config, deps, calls, events };
}
test("real wrapper authenticates reads and never writes on repeated failures", async () => {
  const f = fixture();
  expect(await run(f.config, f.deps)).toBe("held");
  expect(await run(f.config, f.deps)).toBe("held");
  expect(f.calls).toEqual(["GET", "GET"]);
  expect(f.events.at(-1)).toMatchObject({
    policy: "alert-only/v1",
    reason: "stopped",
    severity: "WARNING",
  });
  expect(JSON.stringify(f.events)).not.toContain("secret-test-token");
});
test("image contract pin is checked before loading cloud code", async () => {
  const f = fixture(),
    read = f.deps.read;
  const contract = {
    ...JSON.parse(await read("/work/admin/stop-contract.json")),
    directory: "/opt/batcher-operator",
    receiptDirectory: "/work/operator",
  };
  const bytes = JSON.stringify(contract);
  f.config.operatorDirectory = "/opt/batcher-operator";
  f.config.contractSha256 = sha(bytes);
  f.deps.read = async (path) => (path.endsWith("stop-contract.json") ? bytes : read(path));
  expect(await run(f.config, f.deps)).toBe("held");
  expect(f.calls).toEqual(["GET"]);
  f.config.contractSha256 = "a".repeat(64);
  expect(await run(f.config, f.deps)).toBe("held");
  expect(f.calls).toEqual(["GET"]);
  expect(f.events.at(-1)).toMatchObject({
    reason: "provider-or-binding-failure",
    severity: "WARNING",
    policy: "alert-only/v1",
  });
});
test("changed plan or source alerts before provider reads", async () => {
  for (const suffix of ["plan.json", "control.ts"]) {
    const f = fixture(),
      read = f.deps.read;
    f.deps.read = async (path) => (path.endsWith(suffix) ? "changed" : read(path));
    expect(await run(f.config, f.deps)).toBe("held");
    expect(f.calls).toEqual([]);
    expect(f.events.at(-1)).toMatchObject({
      reason: "provider-or-binding-failure",
      severity: "WARNING",
    });
  }
});
test("every service binding guard observes grace and then alerts", async () => {
  for (const mutation of [
    { uid: "other" },
    { uri: "https://other.example.run.app" },
    { template: { containers: [{ image: `registry/image@sha256:${"b".repeat(64)}` }] } },
    { reconciling: true },
    { observedGeneration: "26" },
  ]) {
    const f = fixture(),
      load = f.deps.loadCloud;
    f.deps.loadCloud = async (path) => {
      const cloud = await load(path);
      return { ...cloud, api: async (...args) => ({ ...(await cloud.api(...args)), ...mutation }) };
    };
    f.config.graceUntil = f.deps.now() + 1;
    expect(await run(f.config, f.deps)).toBe("suppressed");
    expect(f.events.at(-1)).toMatchObject({ reason: "binding-failure", severity: "INFO" });
    f.config.graceUntil = f.deps.now();
    expect(await run(f.config, f.deps)).toBe("held");
    expect(f.events.at(-1)).toMatchObject({ reason: "binding-failure", severity: "WARNING" });
    expect(f.calls).toEqual(["GET", "GET"]);
  }
});
test("provider setup failure uses the same grace and severity policy", async () => {
  const f = fixture();
  f.config.graceUntil = f.deps.now() + 1;
  f.deps.read = async () => {
    throw Error("mount unavailable");
  };
  expect(await run(f.config, f.deps)).toBe("suppressed");
  expect(f.events.at(-1)).toMatchObject({
    policy: "alert-only/v1",
    severity: "INFO",
    reason: "provider-or-binding-failure",
  });
});
test("invalid grace warns before reads and does not break healthy observations", async () => {
  const f = fixture(),
    read = f.deps.read;
  f.config.graceUntil = "wrong" as unknown as number;
  f.deps.read = async (path) => {
    expect(f.events[0]).toMatchObject({ reason: "invalid-grace", severity: "WARNING" });
    return read(path);
  };
  f.deps.request = (async (_url, _init) =>
    Response.json({
      state: "running",
      controlObservedAt: f.deps.now(),
      consecutiveUnclassifiedFailures: 0,
      progressSchema: "batcher-progress/v1",
      lastSuccessfulCycleAt: f.deps.now(),
      firstObservationDeferredAt: null,
      consecutiveObservationDeferrals: 0,
      runtimeStartedAt: 0,
      cycleStartedAt: null,
      cycleDeadlineAt: null,
    })) as typeof fetch;
  expect(await run(f.config, f.deps)).toBe("healthy");
});
test("non-OK healthy-shaped status only alerts", async () => {
  const f = fixture();
  f.deps.request = (async (_url, _init) =>
    Response.json({ state: "running" }, { status: 503 })) as typeof fetch;
  expect(await run(f.config, f.deps)).toBe("held");
  expect(f.events.at(-1)).toMatchObject({ reason: "unavailable", severity: "WARNING" });
  expect(f.calls).toEqual(["GET"]);
});
