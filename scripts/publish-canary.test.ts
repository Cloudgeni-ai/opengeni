import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import libnpmpublish from "libnpmpublish";
import { repoRoot } from "./publishable-workspaces";
import {
  assertCanaryPlan,
  canaryBasePackages,
  confirmCanaryPublication,
  nextCanaryVersion,
  planCanaryVersions,
  publishCanaryArtifact,
  readRegistryPackage,
  verifyCanarySourceBinding,
  workflowCanarySequence,
} from "./publish-canary";

describe("lockstep canary base", () => {
  test("previews the next free patch so canaries sort after the committed release", () => {
    const packages = ["@opengeni/sdk", "@opengeni/contracts", "@opengeni/jev"].map((name) => ({
      name,
      version: "1.0.0",
    }));
    // 1.0.1 is a retired pre-reset version of sdk/contracts, so the whole group skips it.
    const bases = canaryBasePackages(packages);
    expect(bases.map((pkg) => pkg.version)).toEqual(["1.0.2", "1.0.2", "1.0.2"]);
    const versions = planCanaryVersions(
      bases,
      new Map([["@opengeni/sdk", "7.8.1-canary.37189128503001"]]),
      [packages.map((pkg) => pkg.name)],
      workflowCanarySequence("40000000000", "1"),
    );
    for (const version of versions.values()) {
      expect(version).toBe("1.0.2-canary.40000000000001");
      expect(Bun.semver.order(version, "1.0.0")).toBe(1);
    }
    expect(canaryBasePackages([{ name: "@opengeni/jev", version: "1.0.2" }])).toEqual([
      { name: "@opengeni/jev", version: "1.0.3" },
    ]);
  });
});

describe("workflow canary sequence", () => {
  test("uses distinct safe sequences for runs and retries even with stale registry tags", () => {
    const first = workflowCanarySequence("1234", "1");
    const retry = workflowCanarySequence("1234", "2");
    const later = workflowCanarySequence("1235", "1");
    expect(first).toBe(1234001);
    expect(retry).toBeGreaterThan(first);
    expect(later).toBeGreaterThan(retry);
    expect(nextCanaryVersion("1.0.0", "1.0.0-canary.3", first)).toBe("1.0.0-canary.1234001");
    expect(nextCanaryVersion("1.0.0", null, retry)).toBe("1.0.0-canary.1234002");
    expect(() => nextCanaryVersion("1.0.0", "1.0.0-canary.1234005", first)).toThrow("superseded");
    expect(workflowCanarySequence()).toBe(0);
  });

  test("fails before publication for partial, malformed or unsafe identities", () => {
    for (const [run, attempt] of [
      ["1234", undefined],
      [undefined, "1"],
      ["bad", "1"],
      ["1", "0"],
      ["1", "1000"],
      [String(Number.MAX_SAFE_INTEGER), "1"],
    ]) {
      expect(() => workflowCanarySequence(run, attempt)).toThrow();
    }
    expect(() => nextCanaryVersion("1.0.0", null, -1)).toThrow();
    expect(() => nextCanaryVersion("1.0.0", `1.0.0-canary.${Number.MAX_SAFE_INTEGER}`)).toThrow();
  });

  test("rejects older workflow retries instead of reusing a newer invisible reservation", () => {
    for (const attempt of ["1", "2"]) {
      expect(() =>
        nextCanaryVersion("1.0.0", "1.0.0-canary.1235001", workflowCanarySequence("1234", attempt)),
      ).toThrow("dispatch a new publication run");
    }
    expect(
      nextCanaryVersion("1.0.0", "1.0.0-canary.1235001", workflowCanarySequence("1236", "1")),
    ).toBe("1.0.0-canary.1236001");
  });

  test("keeps fixed groups aligned after an earlier partial publication", () => {
    const packages = [
      { name: "a", version: "1.0.0" },
      { name: "b", version: "1.0.0" },
    ];
    const versions = planCanaryVersions(
      packages,
      new Map([
        ["a", "1.0.0-canary.1234001"],
        ["b", "1.0.0-canary.3"],
      ]),
      [["a", "b"]],
      workflowCanarySequence("1234", "2"),
    );
    expect([...versions.values()]).toEqual(["1.0.0-canary.1234002", "1.0.0-canary.1234002"]);
  });
});

describe("nextCanaryVersion", () => {
  test("starts at canary.0 from a stable version", () => {
    expect(nextCanaryVersion("2.0.0", null)).toBe("2.0.0-canary.0");
  });

  test("increments N for the same base", () => {
    expect(nextCanaryVersion("2.0.0", "2.0.0-canary.3")).toBe("2.0.0-canary.4");
  });

  test("restarts at 0 when the committed base moved", () => {
    expect(nextCanaryVersion("2.1.0", "2.0.0-canary.9")).toBe("2.1.0-canary.0");
  });
});

describe("planCanaryVersions", () => {
  const packages = ["tool", "document", "presentation", "spreadsheet", "unrelated"].map((name) => ({
    name,
    version: "1.0.0",
  }));
  const fixed = [["tool", "document", "presentation", "spreadsheet"]];

  test("recovers a partial publish without splitting fixed package versions", () => {
    const versions = planCanaryVersions(
      packages,
      new Map([
        ["tool", "1.0.0-canary.6"],
        ["document", "1.0.0-canary.5"],
        ["presentation", "1.0.0-canary.5"],
        ["spreadsheet", "1.0.0-canary.5"],
        ["unrelated", "1.0.0-canary.2"],
      ]),
      fixed,
    );
    for (const name of fixed[0]!) expect(versions.get(name)).toBe("1.0.0-canary.7");
    expect(versions.get("unrelated")).toBe("1.0.0-canary.3");
  });

  test("uses the furthest published member, even when the tool is behind", () => {
    const versions = planCanaryVersions(
      packages,
      new Map([["spreadsheet", "1.0.0-canary.12"]]),
      fixed,
    );
    for (const name of fixed[0]!) expect(versions.get(name)).toBe("1.0.0-canary.13");
  });

  test("starts a new shared base at zero", () => {
    const versions = planCanaryVersions(packages, new Map([["tool", "0.9.0-canary.99"]]), fixed);
    for (const name of fixed[0]!) expect(versions.get(name)).toBe("1.0.0-canary.0");
  });

  test("refuses inconsistent or incomplete fixed groups before writing versions", () => {
    expect(() =>
      planCanaryVersions(
        [{ name: "tool", version: "2.0.0" }, ...packages.slice(1)],
        new Map(),
        fixed,
      ),
    ).toThrow("committed base version");
    expect(() => planCanaryVersions(packages.slice(1), new Map(), fixed)).toThrow(
      "not publishable",
    );
  });
});

describe("Bun canary publication boundary", () => {
  const sha = "a".repeat(40);
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REPOSITORY: "Cloudgeni-ai/opengeni",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REF: "refs/heads/main",
    GITHUB_RUN_ID: "1234",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SHA: sha,
    GITHUB_WORKFLOW_SHA: sha,
    SOURCE_SHA: sha,
    GITHUB_WORKFLOW_REF:
      "Cloudgeni-ai/opengeni/.github/workflows/publish-canary.yml@refs/heads/main",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.test/oidc",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic-oidc",
    NODE_AUTH_TOKEN: "synthetic-registry-token",
  };

  test("refuses a controller/source or OIDC mismatch before any registry write", () => {
    expect(() => verifyCanarySourceBinding(env, sha, "/source", "/source")).not.toThrow();
    for (const changed of [
      { GITHUB_SHA: "b".repeat(40) },
      { GITHUB_SERVER_URL: "https://example.test" },
      { GITHUB_WORKFLOW_SHA: "b".repeat(40) },
      { SOURCE_SHA: "b".repeat(40) },
      { ACTIONS_ID_TOKEN_REQUEST_URL: "" },
      { ACTIONS_ID_TOKEN_REQUEST_TOKEN: "" },
      { NODE_AUTH_TOKEN: "" },
    ]) {
      expect(() =>
        verifyCanarySourceBinding({ ...env, ...changed }, sha, "/source", "/source"),
      ).toThrow("must agree");
    }
    expect(() => verifyCanarySourceBinding(env, sha, "/older-source", "/controller")).toThrow(
      "must agree",
    );
  });

  test("reads synthetic registry metadata and rejects malformed or occupied existing versions", async () => {
    const metadata = {
      "dist-tags": { latest: "1.0.0", canary: "1.0.1-canary.3" },
      versions: { "1.0.0": {}, "1.0.1-canary.3": {} },
    };
    const request = async (url: string | URL | Request) => {
      expect(String(url)).toContain("%40example%2Fpackage");
      return Response.json(metadata);
    };
    const registry = await readRegistryPackage("@example/package", request, "https://example.test");
    expect(registry).toEqual(metadata);
    expect(() =>
      assertCanaryPlan(
        [{ name: "@example/package" }],
        new Map([["@example/package", "1.0.1-canary.3"]]),
        new Map([["@example/package", registry]]),
      ),
    ).toThrow("already exists");
    await expect(
      readRegistryPackage("@example/package", async () => Response.json({ versions: {} })),
    ).rejects.toThrow("incomplete");
    await expect(
      readRegistryPackage("@example/package", async () =>
        Response.json({ "dist-tags": [], versions: {} }),
      ),
    ).rejects.toThrow("incomplete");
    await expect(
      readRegistryPackage("@example/package", async () => new Response(null, { status: 403 })),
    ).rejects.toThrow("403");
    await expect(
      readRegistryPackage(
        "@example/package",
        async () => new Response(null, { status: 406 }),
        "https://registry.example.test",
        { revalidate: true },
      ),
    ).rejects.toThrow("406");
    await expect(
      readRegistryPackage("@example/package", async () => new Response(null, { status: 503 })),
    ).rejects.toThrow("503");
    await expect(
      readRegistryPackage("@example/package", async () => {
        throw new Error("synthetic network failure");
      }),
    ).rejects.toThrow("synthetic network failure");
  });

  test("admits a new package and preserves an absent latest tag", async () => {
    const absent = await readRegistryPackage(
      "@example/new-package",
      async () => new Response(null, { status: 404 }),
    );
    expect(absent).toEqual({ "dist-tags": {}, versions: {} });
    const existingCanaryOnly = await readRegistryPackage("@example/canary-only", async () =>
      Response.json({
        "dist-tags": { canary: "1.0.1-canary.3" },
        versions: { "1.0.1-canary.3": {} },
      }),
    );
    const packages = [
      { name: "@example/new-package", version: "1.0.1" },
      { name: "@example/canary-only", version: "1.0.1" },
    ];
    const metadata = new Map([
      [packages[0]!.name, absent],
      [packages[1]!.name, existingCanaryOnly],
    ]);
    const plan = planCanaryVersions(
      packages,
      new Map(
        packages.map((pkg) => [pkg.name, metadata.get(pkg.name)!["dist-tags"].canary ?? null]),
      ),
      [packages.map((pkg) => pkg.name)],
      4,
    );
    expect([...plan.values()]).toEqual(["1.0.1-canary.4", "1.0.1-canary.4"]);
    expect(() => assertCanaryPlan(packages, plan, metadata)).not.toThrow();

    const packed = Buffer.from("synthetic-new-package");
    const integrity = `sha512-${createHash("sha512").update(packed).digest("base64")}`;
    const receipt = {
      "dist-tags": { canary: "1.0.1-canary.4" },
      versions: {
        "1.0.1-canary.4": {
          dist: {
            integrity,
            attestations: {
              url: "https://example.test/attestation",
              provenance: { predicateType: "https://slsa.dev/provenance/v1" },
            },
          },
        },
      },
    };
    await confirmCanaryPublication(
      packages[0]!.name,
      "1.0.1-canary.4",
      undefined,
      packed,
      async () => receipt,
    );
    await expect(
      confirmCanaryPublication(
        packages[0]!.name,
        "1.0.1-canary.4",
        undefined,
        packed,
        async () => ({
          ...receipt,
          "dist-tags": { latest: "1.0.1-canary.4", canary: "1.0.1-canary.4" },
        }),
      ),
    ).rejects.toThrow("Stable tag changed");
  });

  test("passes canary-only authenticated provenance options and checks the stable tag", async () => {
    const manifest = {
      name: "@example/package",
      version: "1.0.1-canary.4",
      publishConfig: { access: "public", provenance: true },
    };
    let calls = 0;
    const publish = async (
      _manifest: unknown,
      _tarball: unknown,
      options: Record<string, unknown>,
    ) => {
      calls++;
      expect(options).toEqual({
        registry: "https://example.test",
        forceAuth: { token: "synthetic-token" },
        defaultTag: "canary",
        access: "public",
        provenance: true,
      });
      return { ok: true, transparencyLogUrl: "https://example.test/transparency" };
    };
    await publishCanaryArtifact(
      manifest,
      Buffer.from("synthetic-tarball"),
      "synthetic-token",
      publish as typeof libnpmpublish.publish,
      "https://example.test",
    );
    expect(calls).toBe(1);
    await expect(
      publishCanaryArtifact(
        { ...manifest, tag: "latest" },
        Buffer.from("x"),
        "synthetic-token",
        publish as typeof libnpmpublish.publish,
      ),
    ).rejects.toThrow("invalid");
    expect(calls).toBe(1);
    const packed = Buffer.from("synthetic-tarball");
    const integrity = `sha512-${createHash("sha512").update(packed).digest("base64")}`;
    await confirmCanaryPublication(manifest.name, manifest.version, "1.0.0", packed, async () => ({
      "dist-tags": { latest: "1.0.0", canary: manifest.version },
      versions: {
        [manifest.version]: {
          dist: {
            integrity,
            attestations: {
              url: "https://example.test/attestation",
              provenance: { predicateType: "https://slsa.dev/provenance/v1" },
            },
          },
        },
      },
    }));
    await expect(
      confirmCanaryPublication(manifest.name, manifest.version, "1.0.0", packed, async () => ({
        "dist-tags": { latest: "1.0.1", canary: manifest.version },
        versions: { [manifest.version]: {} },
      })),
    ).rejects.toThrow("Stable tag changed");
    await expect(
      confirmCanaryPublication(manifest.name, manifest.version, "1.0.0", packed, async () => ({
        "dist-tags": { latest: "1.0.0", canary: manifest.version },
        versions: { [manifest.version]: { dist: { integrity: "sha512-wrong" } } },
      })),
    ).rejects.toThrow("archive integrity differs");
  });

  test("settles a delayed registry receipt without relaxing latest, integrity, or provenance", async () => {
    const version = "1.0.1-canary.4";
    const packed = Buffer.from("synthetic-tarball");
    const integrity = `sha512-${createHash("sha512").update(packed).digest("base64")}`;
    const attestation = {
      url: "https://example.test/attestation",
      provenance: { predicateType: "https://slsa.dev/provenance/v1" },
    };
    let elapsed = 0;
    let reads = 0;
    await confirmCanaryPublication(
      "@example/package",
      version,
      "1.0.0",
      packed,
      async (_name, _request, _base, options) => {
        reads++;
        expect(options?.revalidate).toBe(true);
        expect(options?.signal).toBeInstanceOf(AbortSignal);
        if (reads === 1) return { "dist-tags": { latest: "1.0.0" }, versions: {} };
        if (reads === 2) {
          return { "dist-tags": { latest: "1.0.0" }, versions: { [version]: {} } };
        }
        if (reads === 3) {
          return {
            "dist-tags": { latest: "1.0.0", canary: version },
            versions: { [version]: { dist: {} } },
          };
        }
        if (reads === 4) {
          return {
            "dist-tags": { latest: "1.0.0", canary: version },
            versions: { [version]: { dist: { integrity } } },
          };
        }
        if (reads === 5) {
          return {
            "dist-tags": { latest: "1.0.0", canary: version },
            versions: {
              [version]: {
                dist: {
                  integrity,
                  attestations: {
                    ...attestation,
                    provenance: { predicateType: "https://example.test/other" },
                  },
                },
              },
            },
          };
        }
        return {
          "dist-tags": { latest: "1.0.0", canary: version },
          versions: { [version]: { dist: { integrity, attestations: attestation } } },
        };
      },
      {
        now: () => elapsed,
        sleep: async (ms) => {
          elapsed += ms;
        },
        timeoutMs: 6_000,
        pollIntervalMs: 1_000,
      },
    );
    expect(reads).toBe(6);
    expect(elapsed).toBe(5_000);
  });

  test("bounds receipt polling and reports only the missing evidence category", async () => {
    let elapsed = 0;
    let reads = 0;
    await expect(
      confirmCanaryPublication(
        "@example/package",
        "1.0.1-canary.4",
        "1.0.0",
        Buffer.from("synthetic-tarball"),
        async () => {
          reads++;
          return { "dist-tags": { latest: "1.0.0" }, versions: {} };
        },
        {
          now: () => elapsed,
          sleep: async (ms) => {
            elapsed += ms;
          },
          timeoutMs: 2_500,
          pollIntervalMs: 1_000,
        },
      ),
    ).rejects.toThrow("after 3 reads (version_pending)");
    expect(reads).toBe(3);
    expect(elapsed).toBe(2_500);
  });

  test("refuses a valid receipt returned after the monotonic deadline", async () => {
    const version = "1.0.1-canary.4";
    const packed = Buffer.from("synthetic-tarball");
    const integrity = `sha512-${createHash("sha512").update(packed).digest("base64")}`;
    let elapsed = 0;
    let reads = 0;
    await expect(
      confirmCanaryPublication(
        "@example/package",
        version,
        "1.0.0",
        packed,
        async () => {
          reads++;
          elapsed = 1_500;
          return {
            "dist-tags": { latest: "1.0.0", canary: version },
            versions: {
              [version]: {
                dist: {
                  integrity,
                  attestations: {
                    url: "https://example.test/attestation",
                    provenance: { predicateType: "https://slsa.dev/provenance/v1" },
                  },
                },
              },
            },
          };
        },
        { now: () => elapsed, timeoutMs: 1_000 },
      ),
    ).rejects.toThrow("after 1 reads (read_exceeded_deadline)");
    expect(reads).toBe(1);
  });

  test("retries only timed-out receipt reads and fails closed on invalid metadata", async () => {
    const version = "1.0.1-canary.4";
    const packed = Buffer.from("synthetic-tarball");
    const integrity = `sha512-${createHash("sha512").update(packed).digest("base64")}`;
    let elapsed = 0;
    let reads = 0;
    await confirmCanaryPublication(
      "@example/package",
      version,
      "1.0.0",
      packed,
      async () => {
        reads++;
        if (reads === 1) throw new DOMException("synthetic read timeout", "TimeoutError");
        return {
          "dist-tags": { latest: "1.0.0", canary: version },
          versions: {
            [version]: {
              dist: {
                integrity,
                attestations: {
                  url: "https://example.test/attestation",
                  provenance: { predicateType: "https://slsa.dev/provenance/v1" },
                },
              },
            },
          },
        };
      },
      {
        now: () => elapsed,
        sleep: async (ms) => {
          elapsed += ms;
        },
        timeoutMs: 2_500,
        pollIntervalMs: 1_000,
      },
    );
    expect(reads).toBe(2);
    await expect(
      confirmCanaryPublication("@example/package", version, "1.0.0", packed, async () => {
        throw new Error("synthetic malformed metadata");
      }),
    ).rejects.toThrow("synthetic malformed metadata");
  });

  test("requests fresh metadata for post-publication reads", async () => {
    const signal = AbortSignal.timeout(1_000);
    await readRegistryPackage(
      "@example/package",
      async (url, init) => {
        expect(String(url)).toBe("https://registry.example.test/%40example%2Fpackage?write=true");
        expect(init?.method).toBe("GET");
        expect(init?.cache).toBe("no-store");
        expect(init?.signal).toBe(signal);
        expect(init?.headers).toEqual({
          accept: "application/json",
          "cache-control": "no-cache",
        });
        expect(init?.body).toBeUndefined();
        return Response.json({ "dist-tags": {}, versions: {} });
      },
      "https://registry.example.test",
      { signal, revalidate: true },
    );
  });

  test("keeps ordinary metadata reads on the abbreviated registry path", async () => {
    await readRegistryPackage(
      "@example/package",
      async (url, init) => {
        expect(String(url)).toBe("https://registry.example.test/%40example%2Fpackage");
        expect(init?.method).toBe("GET");
        expect(init?.cache).toBe("no-store");
        expect(init?.headers).toEqual({ accept: "application/vnd.npm.install-v1+json" });
        expect(init?.body).toBeUndefined();
        return Response.json({ "dist-tags": {}, versions: {} });
      },
      "https://registry.example.test",
    );
  });

  test("confirms the archive through a fresh full-metadata response when the ordinary read is stale", async () => {
    const version = "1.0.1-canary.4";
    const packed = Buffer.from("synthetic-tarball");
    const integrity = `sha512-${createHash("sha512").update(packed).digest("base64")}`;
    let reads = 0;
    const request = async (url: string | URL | Request, init?: RequestInit) => {
      reads++;
      const fresh = String(url).endsWith("?write=true");
      expect(init?.method).toBe("GET");
      expect(init?.headers).toEqual(
        fresh
          ? { accept: "application/json", "cache-control": "no-cache" }
          : { accept: "application/vnd.npm.install-v1+json" },
      );
      return Response.json({
        "dist-tags": { latest: "1.0.0", ...(fresh ? { canary: version } : {}) },
        versions: fresh
          ? {
              [version]: {
                dist: {
                  integrity,
                  attestations: {
                    url: "https://registry.example.test/attestation",
                    provenance: { predicateType: "https://slsa.dev/provenance/v1" },
                  },
                },
              },
            }
          : {},
      });
    };
    const baseline = await readRegistryPackage(
      "@example/package",
      request,
      "https://registry.example.test",
    );
    expect(baseline.versions).toEqual({});
    await confirmCanaryPublication(
      "@example/package",
      version,
      baseline["dist-tags"].latest,
      packed,
      (name, _request, _base, options) =>
        readRegistryPackage(name, request, "https://registry.example.test", options),
    );
    expect(reads).toBe(2);
  });

  test("official publisher's synthetic auth and provenance boundary is isolated from CI", () => {
    const result = spawnSync(
      process.execPath,
      [join(repoRoot, "scripts/fixtures/libnpmpublish-canary.ts")],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "" },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("synthetic publisher boundary passed");
    expect(result.stderr).toBe("");
  });

  test("Bun packs a synthetic workspace archive without executing package scripts", () => {
    const directory = mkdtempSync(join(tmpdir(), "canary-pack-test-"));
    try {
      writeFileSync(
        join(directory, "package.json"),
        JSON.stringify({
          name: "@example/package",
          version: "1.0.1-canary.4",
          scripts: { prepack: "exit 17" },
          files: ["index.js"],
        }),
      );
      writeFileSync(join(directory, "index.js"), "export default true;\n");
      const result = spawnSync(
        "bun",
        ["pm", "pack", "--ignore-scripts", "--quiet", "--destination", directory],
        { cwd: directory, encoding: "utf8" },
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(readFileSync(result.stdout.trim()).length).toBeGreaterThan(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Bun runs the existing publish guard only for a release", () => {
    const cwd = join(repoRoot, "packages/sdk");
    const denied = spawnSync("bun", ["run", "prepublishOnly"], {
      cwd,
      env: { ...process.env, OPENGENI_RELEASE: "0" },
      encoding: "utf8",
    });
    const admitted = spawnSync("bun", ["run", "prepublishOnly"], {
      cwd,
      env: { ...process.env, OPENGENI_RELEASE: "1" },
      encoding: "utf8",
    });
    expect(denied.status).not.toBe(0);
    expect(admitted.status).toBe(0);
  });
});
