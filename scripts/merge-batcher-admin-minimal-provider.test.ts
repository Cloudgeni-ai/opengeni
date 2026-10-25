import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import {
  run,
  type Configuration,
  type Dependencies,
} from "../docs/merge-batcher-admin/minimal-watchdog-provider";
const sha = (v: string) => createHash("sha256").update(v).digest("hex");

test("image mode loads only pinned image code and forwards contract digest to OFF", async () => {
  const f = fixture();
  const originalRead = f.deps.read;
  const contract = JSON.parse(await originalRead("/work/admin/stop-contract.json"));
  contract.directory = "/opt/batcher-operator";
  contract.receiptDirectory = "/work/operator";
  const bytes = JSON.stringify(contract);
  f.config.operatorDirectory = "/opt/batcher-operator";
  f.config.contractSha256 = sha(bytes);
  f.deps.read = async (path) => (path.endsWith("stop-contract.json") ? bytes : originalRead(path));
  const load = f.deps.loadCloud;
  f.deps.loadCloud = async (path) => {
    expect(path).toBe("/opt/batcher-operator/cloud-auth.ts");
    return load(path);
  };
  f.deps.off = async (_path, _flag, pin, planPin) => {
    expect(pin).toBe(sha(bytes));
    expect(planPin).toBe(f.config.planSha256);
    f.calls.push("OFF");
  };
  await run(f.config, f.deps);
  expect(f.calls).toContain("OFF");
  f.config.contractSha256 = "a".repeat(64);
  const before = f.calls.length;
  await expect(run(f.config, f.deps)).rejects.toThrow("contract changed");
  expect(f.calls).toHaveLength(before);
});
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
  let claimStatus = 0;
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
      api: async (url, method = "GET", body) => {
        calls.push(method);
        if (method === "GET")
          return {
            ...target,
            generation: "27",
            observedGeneration: "27",
            template: { containers: [{ image: target.image }] },
          };
        expect(url).toBe(
          `https://storage.googleapis.com/upload/storage/v1/b/fixture-bucket/o?uploadType=media&ifGenerationMatch=0&name=${encodeURIComponent(config.claimObject)}`,
        );
        expect((body as { activationId: string }).activationId).toBe(config.activationId);
        if (claimStatus)
          throw Object.assign(Error("opaque provider payload"), { status: claimStatus });
        claimStatus = 412;
        return {};
      },
    }),
    request: (async (_url, init) => {
      expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe(
        "Bearer secret-test-token",
      );
      return Response.json({ state: "stopped" });
    }) as typeof fetch,
    off: async (path, flag) => {
      expect(path).toBe("/work/admin");
      expect(flag).toBe("--apply-after-go");
      calls.push("OFF");
    },
    now: () => 2_000_000,
    record: (event) => {
      events.push(event);
    },
  };
  return {
    config,
    deps,
    calls,
    events,
    conflict: (status: number) => {
      claimStatus = status;
    },
  };
}
test("real wrapper uses authenticated status and create-only claim before unchanged OFF", async () => {
  const f = fixture();
  expect(await run(f.config, f.deps)).toBe("manual");
  expect(await run(f.config, f.deps)).toBe("held");
  expect(f.calls).toEqual(["GET", "POST", "OFF", "GET", "POST"]);
  expect(JSON.stringify(f.events)).not.toContain("secret-test-token");
});
test("indeterminate claim cannot invoke OFF, including timeout after possible creation", async () => {
  for (const status of [403, 408, 500]) {
    const f = fixture();
    f.conflict(status);
    await expect(run(f.config, f.deps)).rejects.toThrow("Claim outcome unavailable");
    expect(f.calls).not.toContain("OFF");
  }
});
test("changed plan, source or service blocks before any mutation", async () => {
  for (const kind of ["plan", "source", "service"] as const) {
    const f = fixture();
    if (kind === "service") {
      const load = f.deps.loadCloud;
      f.deps.loadCloud = async (path) => ({
        ...(await load(path)),
        api: async () => ({ uid: "wrong" }),
      });
    } else {
      const read = f.deps.read;
      f.deps.read = (path) =>
        path.endsWith(kind === "plan" ? "plan.json" : "control.ts")
          ? Promise.resolve("changed")
          : read(path);
    }
    await expect(run(f.config, f.deps)).rejects.toThrow();
    expect(f.calls).not.toContain("POST");
    expect(f.calls).not.toContain("OFF");
  }
});
test("OFF uncertainty remains held without claim release or later retry", async () => {
  const f = fixture();
  f.deps.off = async () => {
    f.calls.push("OFF");
    throw Error("uncertain drain");
  };
  expect(await run(f.config, f.deps)).toBe("held");
  expect(await run(f.config, f.deps)).toBe("held");
  expect(f.calls.filter((x) => x === "OFF")).toHaveLength(1);
  expect(f.calls).not.toContain("DELETE");
});

test("each independent live identity and reconciliation guard blocks before claim", async () => {
  for (const mutation of [
    { uid: "other" },
    { uri: "https://other.example.run.app" },
    { template: { containers: [{ image: `registry/image@sha256:${"b".repeat(64)}` }] } },
    { reconciling: true },
    { observedGeneration: "26" },
  ]) {
    const f = fixture(),
      original = f.deps.loadCloud;
    f.deps.loadCloud = async (path) => {
      const cloud = await original(path);
      return {
        ...cloud,
        api: async (url, method = "GET", body) => {
          const value = await cloud.api(url, method, body);
          return method === "GET" ? { ...value, ...mutation } : value;
        },
      };
    };
    await expect(run(f.config, f.deps)).rejects.toThrow("Live service");
    expect(f.calls).toEqual(["GET"]);
  }
});
test("operator directory pin is checked before loading or calling provider", async () => {
  const f = fixture(),
    read = f.deps.read;
  f.deps.read = async (path) => {
    const value = await read(path);
    if (!path.endsWith("stop-contract.json")) return value;
    return JSON.stringify({ ...JSON.parse(value), directory: "/work/other" });
  };
  f.deps.loadCloud = async () => {
    throw Error("must not load");
  };
  await expect(run(f.config, f.deps)).rejects.toThrow("Unexpected OFF package");
  expect(f.calls).toEqual([]);
});
test("non-OK healthy-shaped status cannot suppress proven OFF", async () => {
  const f = fixture();
  f.deps.request = (async (_url, _init) =>
    Response.json(
      { state: "running", controlObservedAt: 2_000_000, consecutiveUnclassifiedFailures: 0 },
      { status: 503 },
    )) as typeof fetch;
  expect(await run(f.config, f.deps)).toBe("manual");
  expect(f.calls).toEqual(["GET", "POST", "OFF"]);
});
