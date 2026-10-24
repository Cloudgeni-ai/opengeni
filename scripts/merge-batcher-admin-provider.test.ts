import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObjectStore, WatchdogCloud } from "../docs/merge-batcher-admin/watchdog-cloud";
import { archive, checkpoint, hydrate } from "../docs/merge-batcher-admin/watchdog-journal";
import { WatchdogGitHub } from "../docs/merge-batcher-admin/watchdog-github";
import { main } from "../docs/merge-batcher-admin/watchdog-main";

const json = (value: unknown, status = 200) => Response.json(value, { status });
function transport(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return ((url: string | URL | Request, init: RequestInit = {}) =>
    handler(String(url), init)) as typeof fetch;
}
test("workload metadata tokens are cached, with no credential file fallback", async () => {
  let tokens = 0;
  const cloud = new WatchdogCloud(
    transport((url, init) => {
      if (url.includes("metadata.google.internal")) {
        tokens++;
        expect(new Headers(init.headers).get("Metadata-Flavor")).toBe("Google");
        return json({ access_token: "fixture-token", expires_in: 3600 });
      }
      expect(new Headers(init.headers).get("Authorization")).toBe("Bearer fixture-token");
      return json({ ok: true });
    }),
  );
  await cloud.json("https://run.googleapis.com/v2/test");
  await cloud.json("https://run.googleapis.com/v2/test");
  expect(tokens).toBe(1);
});
test("GCS read binds media to observed generation and CAS never retries a conflict", async () => {
  const requests: string[] = [];
  const cloud = new WatchdogCloud(
    transport((url) => {
      requests.push(url);
      if (url.includes("metadata.google.internal"))
        return json({ access_token: "fixture", expires_in: 3600 });
      if (url.includes("/upload/")) return json({}, 412);
      if (url.includes("alt=media")) {
        expect(url).toContain("generation=7");
        return json({ saved: true });
      }
      return json({ generation: "7" });
    }),
  );
  const store = new ObjectStore(cloud, "fixture-bucket");
  expect(await store.read("bound/object")).toEqual({ generation: "7", value: { saved: true } });
  expect(await store.cas("bound/object", "7", { next: true })).toBeNull();
  expect(requests.filter((url) => url.includes("/upload/")).length).toBe(1);
  expect(requests.at(-1)).toContain("ifGenerationMatch=7");
});
test("lost upload response stays unknown and is not retried", async () => {
  let writes = 0;
  const cloud = new WatchdogCloud(
    transport((url) => {
      if (url.includes("metadata.google.internal"))
        return json({ access_token: "fixture", expires_in: 3600 });
      writes++;
      throw Error("lost response");
    }),
  );
  await expect(new ObjectStore(cloud, "fixture-bucket").cas("object", null, {})).rejects.toThrow();
  expect(writes).toBe(1);
});
test("non-OK CAS responses are not retried or treated as committed", async () => {
  for (const status of [403, 429, 500]) {
    let writes = 0;
    const cloud = new WatchdogCloud(
      transport((url) => {
        if (url.includes("metadata.google.internal"))
          return json({ access_token: "fixture", expires_in: 3600 });
        writes++;
        return json({}, status);
      }),
    );
    await expect(new ObjectStore(cloud, "fixture-bucket").cas("object", "7", {})).rejects.toThrow(
      "outcome may be unknown",
    );
    expect(writes).toBe(1);
  }
});
test("journal rejects symlink configuration before transport", async () => {
  const root = await mkdtemp(join(tmpdir(), "watchdog-journal-link-"));
  try {
    await writeFile(join(root, "real.json"), "{}");
    await symlink(join(root, "real.json"), join(root, "link.json"));
    await expect(checkpoint(join(root, "link.json"))).rejects.toThrow("regular file");
    await expect(checkpoint(root)).rejects.toThrow("regular file");
  } finally {
    await rm(root, { recursive: true });
  }
});
test("OFF journal persists exact intent and excludes local locks/credential files", async () => {
  const root = await mkdtemp(join(tmpdir(), "watchdog-journal-test-"));
  try {
    await mkdir(join(root, "plan/restore-admission-attempt"), { recursive: true });
    await mkdir(join(root, "plan/off-lock"));
    await writeFile(join(root, "plan/restore-admission-attempt/intent"), "restore-admission");
    await writeFile(join(root, "authorization.header"), "fixture credential excluded");
    await writeFile(join(root, "stop-contract.json"), "{}");
    const value = await archive(root);
    expect(Object.keys(value.files).sort()).toEqual([
      "plan/restore-admission-attempt/intent",
      "stop-contract.json",
    ]);
    const configPath = join(root, "journal-config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        bucket: "fixture-bucket",
        object: "epoch/off",
        generation: "7",
        directory: root,
      }),
    );
    let writes = 0;
    const cloud = new WatchdogCloud(
      transport((url, init) => {
        if (url.includes("metadata.google.internal"))
          return json({ access_token: "fixture", expires_in: 3600 });
        writes++;
        expect(JSON.parse(String(init.body))).toEqual(value);
        return json({ generation: "8" });
      }),
    );
    await checkpoint(configPath, cloud);
    expect(JSON.parse(await readFile(configPath, "utf8")).generation).toBe("8");
    expect(writes).toBe(1);
    const destination = join(root, "hydrate");
    await mkdir(destination);
    await hydrate(destination, value);
    expect(await readFile(join(destination, "plan/restore-admission-attempt/intent"), "utf8")).toBe(
      "restore-admission",
    );
    await expect(
      hydrate(destination, { schema: 1, files: { "plan/../../escape": "" } }),
    ).rejects.toThrow();
    await symlink("/not-followed", join(root, "plan/link"));
    await expect(archive(root)).rejects.toThrow("symlinks");
  } finally {
    await rm(root, { recursive: true });
  }
});
test("journal CAS loss retains prior generation and aborts before caller can continue", async () => {
  const root = await mkdtemp(join(tmpdir(), "watchdog-journal-conflict-"));
  try {
    const path = join(root, "journal-config.json");
    await writeFile(
      path,
      JSON.stringify({
        bucket: "fixture-bucket",
        object: "epoch/off",
        generation: "7",
        directory: root,
      }),
    );
    const cloud = new WatchdogCloud(
      transport((url) =>
        url.includes("metadata.google.internal")
          ? json({ access_token: "fixture", expires_in: 3600 })
          : json({}, 412),
      ),
    );
    await expect(checkpoint(path, cloud)).rejects.toThrow("CAS lost");
    expect(JSON.parse(await readFile(path, "utf8")).generation).toBe("7");
  } finally {
    await rm(root, { recursive: true });
  }
});

const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
class KeyCloud extends WatchdogCloud {
  override async secret() {
    return key;
  }
}
test("extra token grants are rejected before repository reads", async () => {
  let calls = 0;
  const github = new WatchdogGitHub(
    new KeyCloud(),
    { appId: 1, installationId: 2, repositoryId: 3, keyVersion: "fixture" },
    transport((_url, init) => {
      calls++;
      return json({
        token: "fixture",
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        permissions: { ...JSON.parse(String(init.body)).permissions, workflows: "write" },
      });
    }),
  );
  await expect(github.token()).rejects.toThrow("permissions mismatch");
  expect(calls).toBe(1);
});
test("repository verification failures never leave a usable cached token", async () => {
  let mints = 0;
  const github = new WatchdogGitHub(
    new KeyCloud(),
    { appId: 1001, installationId: 1002, repositoryId: 1003, keyVersion: "fixture" },
    transport((url) => {
      if (url.includes("/access_tokens")) {
        mints++;
        return json({
          token: "fixture",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          permissions: {
            administration: "write",
            contents: "read",
            actions: "read",
            issues: "write",
          },
        });
      }
      return json({ total_count: 1, repositories: [{ id: 1003, full_name: "wrong/repository" }] });
    }),
  );
  await expect(github.token()).rejects.toThrow("repository mismatch");
  await expect(github.token()).rejects.toThrow("repository mismatch");
  expect(mints).toBe(2);
});
test("watchdog App mint is selected-repository and narrower than runtime mutation grants", async () => {
  let posts = 0;
  const github = new WatchdogGitHub(
    new KeyCloud(),
    { appId: 1001, installationId: 1002, repositoryId: 1003, keyVersion: "fixture" },
    transport((url, init) => {
      if (url.endsWith("/access_tokens")) {
        posts++;
        const body = JSON.parse(String(init.body));
        expect(body.repository_ids).toEqual([1003]);
        expect(body.permissions).toEqual({
          administration: "write",
          contents: "read",
          actions: "read",
          issues: "write",
        });
        return json({
          token: "fixture",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          permissions: body.permissions,
        });
      }
      return json({
        total_count: 1,
        repositories: [{ id: 1003, full_name: "Cloudgeni-ai/opengeni" }],
      });
    }),
  );
  expect(await github.token()).toBe("fixture");
  expect(await github.token()).toBe("fixture");
  expect(posts).toBe(1);
  await expect(
    new WatchdogGitHub(new KeyCloud(), {
      appId: 5425399,
      installationId: 1,
      repositoryId: 1,
      keyVersion: "fixture",
    }).token(),
  ).rejects.toThrow("separate App");
});
test("unconfigured entrypoint emits exactly one error terminal event without network/secret output", async () => {
  const events: string[] = [];
  const original = console.log;
  console.log = (value: unknown) => {
    events.push(String(value));
  };
  try {
    expect(await main({})).toBe(1);
  } finally {
    console.log = original;
  }
  expect(events.length).toBe(1);
  expect(JSON.parse(events[0]!).event).toBe("batcher_watchdog_completed");
  expect(JSON.parse(events[0]!).result).toBe("error");
  expect(JSON.parse(events[0]!).executionName).toBeNull();
});
test("state fence capability mints contents-only, without administration or comment permission", async () => {
  const github = new WatchdogGitHub(
    new KeyCloud(),
    { appId: 5425399, installationId: 1002, repositoryId: 1003, keyVersion: "fixture" },
    transport((url, init) => {
      if (url.endsWith("/access_tokens")) {
        const body = JSON.parse(String(init.body));
        expect(body.permissions).toEqual({ contents: "write" });
        return json({
          token: "fixture-state",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          permissions: body.permissions,
        });
      }
      return json({
        total_count: 1,
        repositories: [{ id: 1003, full_name: "Cloudgeni-ai/opengeni" }],
      });
    }),
    "state-fence",
  );
  expect(await github.token()).toBe("fixture-state");
  await expect(github.notify(1, "id", "reason", null, "first")).rejects.toThrow("cannot post");
});
