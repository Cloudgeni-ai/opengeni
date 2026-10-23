import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { rm, writeFile } from "node:fs/promises";
import { WatchdogCloud } from "../docs/merge-batcher-admin/watchdog-cloud";
import { WatchdogGitHub } from "../docs/merge-batcher-admin/watchdog-github";
import {
  appPath,
  createProvider,
  digest,
  type CoreBridge,
  type RuntimeConfig,
} from "../docs/merge-batcher-admin/watchdog-provider";
import { main } from "../docs/merge-batcher-admin/watchdog-main";
import { prepare, type Snapshot } from "../docs/merge-batcher-admin/bundle";
import type { ProviderEvidencePort } from "../docs/merge-batcher-admin/watchdog-provider";
import type { Observation, Ports } from "../docs/merge-batcher-admin/watchdog";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const image = `registry.test/batcher@sha256:${"a".repeat(64)}`;
const plan = JSON.stringify({ fixture: true });
const config: RuntimeConfig = {
  schema: 1,
  binding: {
    deploymentUid: "uid",
    image,
    activation: "epoch",
    planDigest: digest(plan),
    configDigest: "e".repeat(64),
    serviceGeneration: "1",
    revision: "rev-1",
    repository: "Cloudgeni-ai/opengeni",
    stateRef: "refs/heads/batcher-state",
    phaseLimits: { cycle: { timeoutMs: 900_000, marginMs: 120_000 } },
  },
  jobResource: "projects/p/locations/l/jobs/watchdog",
  serviceResource: "projects/p/locations/l/services/batcher",
  watchdogImage: image,
  bucket: "fixture",
  prefix: "fixture",
  seedObject: "seed",
  seedGeneration: "7",
  coreModule: "/app/core.ts",
  coreModuleDigest: "b".repeat(64),
  operatorDirectory: "/app/operator",
  app: { appId: 1, installationId: 2, repositoryId: 3, keyVersion: "fixture" },
  stateApp: { appId: 5425399, installationId: 2, repositoryId: 3, keyVersion: "fixture" },
  incidentThread: 9,
};
class Cloud extends WatchdogCloud {
  objects = new Map<string, { generation: string; value: unknown }>();
  requests: string[] = [];
  execution: unknown = {};
  override async secret() {
    return privateKey;
  }
  override async request(url: string, init: RequestInit = {}) {
    this.requests.push(url);
    const parsed = new URL(url);
    if (parsed.hostname === "run.googleapis.com") return Response.json(this.execution);
    const name = parsed.pathname.startsWith("/upload/")
      ? parsed.searchParams.get("name")!
      : decodeURIComponent(parsed.pathname.split("/o/")[1]!);
    const current = this.objects.get(name);
    if (parsed.pathname.startsWith("/upload/")) {
      if (parsed.searchParams.get("ifGenerationMatch") !== (current?.generation ?? "0"))
        return new Response(null, { status: 412 });
      const generation = String(Number(current?.generation ?? "0") + 1);
      this.objects.set(name, { generation, value: JSON.parse(String(init.body)) });
      return Response.json({ generation });
    }
    if (
      !current ||
      (parsed.searchParams.has("generation") &&
        parsed.searchParams.get("generation") !== current.generation)
    )
      return new Response(null, { status: 404 });
    return Response.json(
      parsed.searchParams.get("alt") === "media"
        ? current.value
        : { generation: current.generation },
    );
  }
}
const transport = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = String(input);
  if (url.endsWith("access_tokens"))
    return Response.json({
      token: "fixture-admin",
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      permissions: JSON.parse(String(init.body)).permissions,
    });
  if (url.includes("installation/repositories"))
    return Response.json({
      total_count: 1,
      repositories: [{ id: 3, full_name: "Cloudgeni-ai/opengeni" }],
    });
  throw Error("Unexpected fake GitHub request");
}) as typeof fetch;
function seeded() {
  const cloud = new Cloud();
  cloud.objects.set("seed", {
    generation: "7",
    value: {
      schema: 1,
      files: {
        "plan/plan.json": Buffer.from(plan).toString("base64"),
        "stop-contract.json": Buffer.from(
          JSON.stringify({
            directory: config.operatorDirectory,
            deployment: { uid: "uid", image },
          }),
        ).toString("base64"),
      },
    },
  });
  return cloud;
}
function bridge(): CoreBridge {
  return {
    observe: async () => {
      throw Error("unused");
    },
    claimStop: async (_sha, id) => ({
      outcome: "claimed",
      incidentId: id,
      activation: "epoch",
      stateSha: "c".repeat(40),
    }),
    verifyClaim: async () => {},
    verifyOffReceipt: async () => {},
  };
}
test("application prefix refuses normalized traversal", () => {
  expect(appPath("/app/core.ts")).toBe(true);
  for (const path of [
    "/app/../outside/core.ts",
    "/application/core.ts",
    "/app/..",
    "relative/core.ts",
  ])
    expect(appPath(path)).toBe(false);
});
test("provider evidence uses authenticated complete rules snapshots and never synthesizes STOP", async () => {
  const before: Snapshot = {
    repository: {
      full_name: "Cloudgeni-ai/opengeni",
      default_branch: "main",
      allow_squash_merge: true,
    },
    classic: { nodes: [], pageInfo: { hasNextPage: false } },
    rulesets: [
      {
        id: 101,
        name: "Protection",
        source_type: "Repository",
        source: "Cloudgeni-ai/opengeni",
        target: "branch",
        enforcement: "active",
        bypass_actors: [],
        conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
        rules: [
          { type: "deletion" },
          { type: "non_fast_forward" },
          { type: "pull_request", parameters: { allowed_merge_methods: ["squash"] } },
        ],
      },
    ],
  };
  const prepared = prepare(before, 501, 999),
    bytes = JSON.stringify(prepared);
  const cloud = seeded();
  const cfg = { ...config, binding: { ...config.binding, planDigest: digest(bytes) } };
  const source = cloud.objects.get("seed")!.value as { files: { [name: string]: string } };
  source.files["plan/plan.json"] = Buffer.from(bytes).toString("base64");
  const guard = {
    ...prepared.guard,
    id: 201,
    source_type: "Repository",
    source: "Cloudgeni-ai/opengeni",
  };
  const namespace = {
    ...prepared.namespace,
    id: 202,
    source_type: "Repository",
    source: "Cloudgeni-ai/opengeni",
  };
  source.files["plan/guard-receipt.json"] = Buffer.from(JSON.stringify(guard)).toString("base64");
  source.files["plan/namespace-receipt.json"] = Buffer.from(JSON.stringify(namespace)).toString(
    "base64",
  );
  let port: ProviderEvidencePort | undefined,
    snapshot = before,
    fail = false;
  const directories: string[] = [];
  try {
    await createProvider(cfg, cloud, {
      loadBridge: async (_cfg, _token, evidence) => {
        port = evidence;
        return bridge();
      },
      transport,
      off: async () => {
        throw Error("No OFF allowed");
      },
      run: async (args, env) => {
        expect(args[3]).toBe("snapshot");
        expect(env.GH_TOKEN).toBe("fixture-admin");
        const admin = args[2]!;
        directories.push(admin);
        if (fail) throw Error("unavailable snapshot");
        const path = join(admin, "snapshot.json");
        await writeFile(path, JSON.stringify(snapshot));
        return path;
      },
    });
    expect((await port!.read()).policy).toBe("manual");
    snapshot = {
      ...before,
      rulesets: [{ ...before.rulesets[0]!, ...prepared.admission }, guard, namespace],
    };
    expect((await port!.read()).policy).toBe("applied");
    snapshot = { ...before, rulesets: [] };
    expect((await port!.read()).policy).toBe("drift");
    fail = true;
    await expect(port!.read()).rejects.toThrow("unavailable");
    await expect(port!.verifyStopped({})).rejects.toThrow();
    expect(cloud.requests.some((url) => url.includes("/services/batcher"))).toBe(true);
    expect(cloud.requests.some((url) => url.includes("/upload/"))).toBe(false);
  } finally {
    for (const directory of directories) await rm(directory, { recursive: true });
  }
});
test("core callbacks never inherit temporary restoration identity; seed is generation pinned", async () => {
  const old = process.env.GH_TOKEN,
    oldJournal = process.env.BATCHER_ADMIN_JOURNAL_CONFIG;
  delete process.env.GH_TOKEN;
  delete process.env.BATCHER_ADMIN_JOURNAL_CONFIG;
  let directory: string | undefined;
  try {
    const core = bridge(),
      calls: string[] = [],
      cloud = seeded();
    const check = (stage: string) => {
      calls.push(stage);
      expect(process.env.GH_TOKEN).toBeUndefined();
      expect(process.env.BATCHER_ADMIN_JOURNAL_CONFIG).toBeUndefined();
    };
    core.claimStop = async (_sha, id) => {
      check("claim");
      return { outcome: "claimed", incidentId: id, activation: "epoch", stateSha: "c".repeat(40) };
    };
    core.verifyClaim = async () => {
      check("verify");
    };
    core.verifyOffReceipt = async () => {
      check("receipt");
    };
    const provider = await createProvider(config, cloud, {
      loadBridge: async () => core,
      transport,
      off: async (admin) => {
        directory = admin;
        expect(process.env.GH_TOKEN).toBe("fixture-admin");
        const receipt = join(admin, "receipt.json");
        await writeFile(receipt, "{}");
        return receipt;
      },
    });
    expect(await provider.ports.off({ revision: "d".repeat(40) } as Observation, "incident")).toBe(
      digest("{}"),
    );
    expect(calls).toEqual(["claim", "verify", "receipt"]);
    expect(
      cloud.requests.some((url) => url.includes("seed?") && url.includes("generation=7")),
    ).toBe(true);
  } finally {
    if (old === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = old;
    if (oldJournal === undefined) delete process.env.BATCHER_ADMIN_JOURNAL_CONFIG;
    else process.env.BATCHER_ADMIN_JOURNAL_CONFIG = oldJournal;
    if (directory) await rm(directory, { recursive: true });
  }
});
test("unknown fence submits no OFF and restart missing journal or claim is null without seed reconstruction", async () => {
  for (const outcome of ["conflict", "unknown"] as const) {
    const core = bridge(),
      cloud = seeded();
    let effects = 0;
    core.claimStop = async (_sha, id) => ({
      outcome,
      incidentId: id,
      activation: "epoch",
      stateSha: "c".repeat(40),
    });
    const provider = await createProvider(config, cloud, {
      loadBridge: async () => core,
      transport,
      off: async () => {
        effects++;
        return "";
      },
    });
    await expect(
      provider.ports.off({ revision: "d".repeat(40) } as Observation, "id"),
    ).rejects.toThrow("fence");
    expect(cloud.requests).toEqual([]);
    expect(effects).toBe(0);
    expect(await provider.ports.reconcile(config.binding, "id")).toBeNull();
    expect(cloud.requests.some((url) => url.includes("seed"))).toBe(false);
    core.verifyClaim = async () => {
      throw Error("claim changed");
    };
    expect(await provider.ports.reconcile(config.binding, "id")).toBeNull();
    expect(effects).toBe(0);
  }
});
test("execution proof requires exact image and job and not reconciling", async () => {
  const cloud = seeded();
  const provider = await createProvider(config, cloud, {
    loadBridge: async () => bridge(),
    transport,
    off: async () => "",
  });
  const name = `${config.jobResource}/executions/run`;
  const valid = {
    name,
    job: config.jobResource,
    template: { containers: [{ image }] },
    completionTime: "2026-10-23T00:00:00Z",
    reconciling: false,
  };
  cloud.execution = valid;
  expect(await provider.ports.execution(name)).toBe("terminal");
  cloud.execution = { ...valid, template: { containers: [{ image: "other" }] } };
  expect(await provider.ports.execution(name)).toBe("unknown");
  cloud.execution = { ...valid, job: "other" };
  expect(await provider.ports.execution(name)).toBe("unknown");
  cloud.execution = { ...valid, reconciling: true };
  expect(await provider.ports.execution(name)).toBe("running");
});
test("untrusted marker does not suppress notification and reconciliation never posts", async () => {
  const marker = `<!-- batcher-watchdog:${digest("incident")} -->`;
  let posts = 0;
  let author = 999;
  const github = new WatchdogGitHub(new Cloud(), config.app, (async (url, init) => {
    if (String(url).includes("comments")) {
      if (init?.method === "POST") {
        posts++;
        return Response.json({});
      }
      return Response.json([{ body: marker, performed_via_github_app: { id: author } }]);
    }
    return transport(url, init);
  }) as typeof fetch);
  expect(await github.notify(9, "incident", "fixture", null, "reconcile")).toBe(false);
  expect(posts).toBe(0);
  expect(await github.notify(9, "incident", "fixture", null, "first")).toBe(true);
  expect(posts).toBe(1);
  author = 1;
  expect(await github.notify(9, "incident", "fixture", null, "reconcile")).toBe(true);
  expect(posts).toBe(1);
});
test("malformed config emits one terminal event; mismatched own execution never observes health", async () => {
  const env = {
    WATCHDOG_CONFIG_BUCKET: "fixture",
    WATCHDOG_CONFIG_OBJECT: "config",
    WATCHDOG_CONFIG_GENERATION: "1",
    CLOUD_RUN_EXECUTION: "run",
    CLOUD_RUN_JOB: "watchdog",
  };
  const log = console.log;
  const events: unknown[] = [];
  console.log = (line) => {
    events.push(JSON.parse(String(line)));
  };
  try {
    for (const value of [{}, { jobResource: config.jobResource }, config]) {
      events.length = 0;
      const cloud = new Cloud();
      cloud.objects.set("config", { generation: "1", value });
      let reads = 0;
      const ports = {
        execution: async () => "unknown",
        read: async () => {
          reads++;
          throw Error("must not observe");
        },
      } as unknown as Ports;
      expect(
        await main(env, {
          cloud: () => cloud,
          createProvider: async () => ({ ports, close: async () => {} }),
        }),
      ).toBe(1);
      expect(reads).toBe(0);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ event: "batcher_watchdog_completed", result: "error" });
    }
  } finally {
    console.log = log;
  }
});
