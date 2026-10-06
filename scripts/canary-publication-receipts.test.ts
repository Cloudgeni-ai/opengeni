import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import libnpmpublish from "libnpmpublish";
import {
  CanaryReceiptStore,
  CANARY_RESPONSE_BYTES,
  type CanaryCustody,
} from "./canary-publication-receipts";
import {
  confirmCanaryCohort,
  freezeCanaryCohort,
  publishAndVerifyCanaryCohort,
  publishPreparedCanaries,
  readRegistryPackage,
} from "./publish-canary";
import { repoRoot } from "./publishable-workspaces";

const roots: string[] = [];
const identity = {
  source: "a".repeat(40),
  workflowSource: "a".repeat(40),
  runId: "1234",
  attempt: "1",
};
const version = "1.0.1-canary.4";
const names = ["@opengeni/sdk", "@opengeni/react", "@opengeni/codemode", "@opengeni/ogtool"];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "canary-receipt-test-"));
  roots.push(root);
  const directory = join(root, "receipts");
  const store = new CanaryReceiptStore(directory, identity);
  const events = (selected = directory) =>
    readdirSync(selected)
      .filter((file) => file.endsWith(".json"))
      .sort()
      .map((file) => JSON.parse(readFileSync(join(selected, file), "utf8")));
  const packages = names.map((name, index) => ({
    name,
    version,
    previousLatest: "1.0.0",
    manifest: { name, version, publishConfig: { access: "public", provenance: true } },
    packed: Buffer.from(`synthetic-archive-${index}`),
  }));
  return { root, directory, store, events, packages };
}
function accepted() {
  return { ok: true, status: 201, transparencyLogUrl: "https://search.sigstore.dev/?logIndex=7" };
}
function metadata(pkg: { integrity: string }, ready = true) {
  return {
    "dist-tags": { latest: "1.0.0", ...(ready ? { canary: version } : {}) },
    versions: ready
      ? {
          [version]: {
            dist: {
              integrity: pkg.integrity,
              attestations: {
                url: "https://registry.example.test/attestation",
                provenance: {
                  predicateType: "https://slsa.dev/provenance/v1",
                },
              },
            },
          },
        }
      : {},
  };
}
function reader(response: (name: string) => Response): typeof readRegistryPackage {
  return (name, _request, _base, options) => {
    const snapshot = response(name);
    return readRegistryPackage(
      name,
      async (url, init) => {
        expect(init?.method).toBe("GET");
        expect(init?.redirect).toBe("manual");
        expect(init?.credentials).toBe("omit");
        expect(init?.headers).toEqual({ accept: "application/json", "cache-control": "no-cache" });
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        if (!options?.selectedVersion) {
          expect(String(url)).toBe(
            `https://registry.example.test/${encodeURIComponent(name)}?write=true`,
          );
          return snapshot;
        }
        const selected = options.selectedVersion;
        const current = await snapshot.clone().json();
        if (String(url).includes("/dist-tags?")) {
          expect(String(url)).toBe(
            `https://registry.example.test/-/package/${encodeURIComponent(name)}/dist-tags?write=true`,
          );
          return Response.json(current["dist-tags"]);
        }
        expect(String(url)).toBe(
          `https://registry.example.test/${encodeURIComponent(name)}/${selected}?write=true`,
        );
        const manifest = current.versions?.[selected];
        return manifest
          ? Response.json({ ...manifest, name, version: selected })
          : new Response(null, { status: 404 });
      },
      "https://registry.example.test",
      options,
    );
  };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("canary acknowledgement and receipt phases", () => {
  test("retains every acknowledgement before the next write and waits for visibility only afterward", async () => {
    const f = fixture();
    const cohort = freezeCanaryCohort(f.packages, f.store);
    const writes: string[] = [];
    const calls: string[] = [];
    let delayedReads = 0,
      elapsed = 0;
    const publish = async (
      manifest: Record<string, unknown>,
      _packed: Buffer,
      options: Record<string, unknown>,
    ) => {
      expect(f.events().filter((event) => event.kind === "WRITE_ACKNOWLEDGED")).toHaveLength(
        writes.length,
      );
      expect(f.events().filter((event) => event.kind === "COHORT_PLAN")).toHaveLength(1);
      expect(options.provenance).toBe(true);
      expect(options.retry).toEqual({ retries: 0 });
      expect(options.signal).toBeInstanceOf(AbortSignal);
      writes.push(String(manifest.name));
      calls.push("write");
      return accepted();
    };
    const pins = await publishAndVerifyCanaryCohort(cohort, f.store, "synthetic-secret-token", {
      publish: publish as typeof libnpmpublish.publish,
      read: reader((name) => {
        const final = writes.length === cohort.length;
        calls.push(final ? "receipt" : "prewrite");
        const pkg = cohort.find((entry) => entry.name === name)!;
        if (!final) return Response.json(metadata(pkg, false));
        const ready = name !== names[0] || ++delayedReads >= 3;
        return Response.json(metadata(pkg, ready));
      }),
      now: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms;
      },
      timeoutMs: 5000,
    });
    expect(writes).toEqual(names);
    expect(calls.slice(0, 8)).toEqual([
      "prewrite",
      "write",
      "prewrite",
      "write",
      "prewrite",
      "write",
      "prewrite",
      "write",
    ]);
    expect(pins).toEqual(Object.fromEntries(names.map((name) => [name, version])));
    expect(elapsed).toBe(2000);
    expect(f.events().filter((event) => event.kind === "WRITE_ACKNOWLEDGED")).toHaveLength(4);
    expect(f.events().filter((event) => event.kind === "COHORT_READS_MATCHED")).toHaveLength(1);
    expect(JSON.stringify(f.events())).not.toContain("synthetic-secret-token");
  });

  test("a bounded visibility failure retains all write acknowledgements without replay or pins", async () => {
    const f = fixture();
    const cohort = freezeCanaryCohort(f.packages, f.store);
    let writes = 0,
      elapsed = 0;
    await expect(
      publishAndVerifyCanaryCohort(cohort, f.store, "synthetic-token", {
        publish: (async () => {
          writes++;
          return accepted();
        }) as typeof libnpmpublish.publish,
        read: reader((name) =>
          Response.json(metadata(cohort.find((pkg) => pkg.name === name)!, false)),
        ),
        now: () => elapsed,
        sleep: async (ms) => {
          elapsed += ms;
        },
        timeoutMs: 2000,
      }),
    ).rejects.toThrow("version_pending");
    expect(writes).toBe(4);
    expect(elapsed).toBe(2000);
    expect(f.events().filter((event) => event.kind === "WRITE_ACKNOWLEDGED")).toHaveLength(4);
    expect(f.events().filter((event) => event.kind === "COHORT_READS_MATCHED")).toHaveLength(0);
    expect(f.events().filter((event) => event.kind === "SITE_PINS_WRITTEN")).toHaveLength(0);
  });

  test("prepacking refuses a bad later manifest before any intent", () => {
    const f = fixture();
    f.packages[3]!.manifest.publishConfig.access = "restricted";
    expect(() => freezeCanaryCohort(f.packages, f.store)).toThrow("invalid");
    expect(f.events()).toHaveLength(0);
  });

  test("changed packed bytes are rejected before write admission", async () => {
    const f = fixture();
    const cohort = freezeCanaryCohort(f.packages, f.store);
    cohort[0]!.packed[0] = cohort[0]!.packed[0]! ^ 1;
    let writes = 0;
    await expect(
      publishPreparedCanaries(
        cohort,
        f.store,
        "synthetic-token",
        reader(() => Response.json({})),
        (async () => {
          writes++;
          return accepted();
        }) as typeof libnpmpublish.publish,
      ),
    ).rejects.toThrow("Frozen canary archive changed");
    expect(writes).toBe(0);
    expect(f.events().filter((event) => event.kind === "WRITE_INTENT")).toHaveLength(0);
  });

  test("stable latest drift prevents the next write", async () => {
    const f = fixture();
    const cohort = freezeCanaryCohort(f.packages, f.store);
    let writes = 0;
    await expect(
      publishPreparedCanaries(
        cohort,
        f.store,
        "synthetic-token",
        reader(() => Response.json({ "dist-tags": { latest: "1.1.0" }, versions: {} })),
        (async () => {
          writes++;
          return accepted();
        }) as typeof libnpmpublish.publish,
      ),
    ).rejects.toThrow("Stable tag changed before");
    expect(writes).toBe(0);
    expect(f.events().filter((event) => event.kind === "WRITE_INTENT")).toHaveLength(0);
  });

  test("an uncertain library write stops the untouched remainder and excludes secret errors", async () => {
    const f = fixture();
    const cohort = freezeCanaryCohort(f.packages, f.store);
    let writes = 0;
    await expect(
      publishPreparedCanaries(
        cohort,
        f.store,
        "synthetic-secret-token",
        reader((name) => Response.json(metadata(cohort.find((pkg) => pkg.name === name)!, false))),
        (async () => {
          writes++;
          throw new Error("synthetic-secret-token");
        }) as typeof libnpmpublish.publish,
      ),
    ).rejects.toThrow("outcome is unknown");
    expect(writes).toBe(1);
    expect(f.events().filter((event) => event.kind === "WRITE_UNKNOWN")).toHaveLength(1);
    expect(f.events().filter((event) => event.kind === "WRITE_ACKNOWLEDGED")).toHaveLength(0);
    expect(JSON.stringify(f.events())).not.toContain("synthetic-secret-token");
  });

  test("lost acknowledgement storage leaves the original actual intent without permitting another write", async () => {
    const f = fixture();
    const cohort = freezeCanaryCohort(f.packages, f.store);
    const retained = join(f.root, "retained");
    const custody: CanaryCustody = {
      capture: (...args) => f.store.capture(...args),
      record: (kind, fields) => {
        if (kind === "WRITE_ACKNOWLEDGED") renameSync(f.directory, retained);
        return f.store.record(kind, fields);
      },
    };
    let writes = 0;
    await expect(
      publishPreparedCanaries(
        cohort,
        custody,
        "synthetic-token",
        reader((name) => Response.json(metadata(cohort.find((pkg) => pkg.name === name)!, false))),
        (async () => {
          writes++;
          return accepted();
        }) as typeof libnpmpublish.publish,
      ),
    ).rejects.toThrow("outcome is unknown");
    expect(writes).toBe(1);
    expect(f.events(retained).filter((event) => event.kind === "WRITE_INTENT")).toHaveLength(1);
    expect(f.events(retained).filter((event) => event.kind === "WRITE_ACKNOWLEDGED")).toHaveLength(
      0,
    );
  });

  test("a caller timeout is unknown even if the detached library later returns success", async () => {
    const f = fixture();
    const cohort = freezeCanaryCohort(f.packages, f.store);
    let writes = 0,
      signal: AbortSignal | undefined;
    let complete!: (value: ReturnType<typeof accepted>) => void;
    const pending = new Promise<ReturnType<typeof accepted>>((resolve) => {
      complete = resolve;
    });
    const publish = async (
      _manifest: unknown,
      _archive: unknown,
      options: { signal?: AbortSignal },
    ) => {
      writes++;
      signal = options.signal;
      return pending;
    };
    await expect(
      publishPreparedCanaries(
        cohort,
        f.store,
        "synthetic-token",
        reader((name) => Response.json(metadata(cohort.find((pkg) => pkg.name === name)!, false))),
        publish as typeof libnpmpublish.publish,
        10,
      ),
    ).rejects.toThrow("outcome is unknown");
    expect(signal?.aborted).toBe(true);
    complete(accepted());
    await pending;
    await Bun.sleep(0);
    expect(writes).toBe(1);
    expect(f.events().filter((event) => event.kind === "WRITE_UNKNOWN")).toHaveLength(1);
    expect(f.events().filter((event) => event.kind === "WRITE_ACKNOWLEDGED")).toHaveLength(0);
  });

  test("an intent-only terminated child cannot be resumed through the same receipt directory", () => {
    const f = fixture();
    const directory = join(f.root, "child-receipts");
    const source = `import {CanaryReceiptStore} from ${JSON.stringify(join(repoRoot, "scripts/canary-publication-receipts.ts"))};
      const store = new CanaryReceiptStore(${JSON.stringify(directory)}, ${JSON.stringify(identity)});
      store.record("WRITE_INTENT", {package:"@example/package",version:"1.0.1-canary.4"}); process.exit(7);`;
    const result = spawnSync(process.execPath, ["--no-env-file", "-e", source], {
      env: { PATH: process.env.PATH ?? "" },
      encoding: "utf8",
    });
    expect(result.status).toBe(7);
    expect(f.events(directory).map((event) => event.kind)).toEqual(["WRITE_INTENT"]);
    expect(() => new CanaryReceiptStore(directory, identity)).toThrow();
  });
});

describe("strict raw receipt acceptance", () => {
  test("delayed confirmation does not retain unrelated version histories on every poll", async () => {
    const f = fixture();
    const cohort = freezeCanaryCohort(f.packages, f.store).slice(0, 1);
    const pkg = cohort[0]!;
    let fullReads = 0,
      versionReads = 0,
      elapsed = 0;
    const history = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [
        `0.0.${index}`,
        { readme: "synthetic unrelated history".repeat(4096) },
      ]),
    );
    const request = async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      if (String(url).includes("/dist-tags?")) {
        return Response.json({ latest: pkg.previousLatest, canary: version });
      }
      if (String(url).includes(`/${version}?`)) {
        if (++versionReads <= 70) return new Response(null, { status: 404 });
        return Response.json({ name: pkg.name, version, ...metadata(pkg).versions[version] });
      }
      fullReads++;
      return Response.json({ "dist-tags": { latest: pkg.previousLatest }, versions: history });
    };
    await readRegistryPackage(pkg.name, request, "https://registry.example.test", {
      custody: f.store,
    });
    await confirmCanaryCohort(
      cohort,
      (name, _request, _base, options) =>
        readRegistryPackage(name, request, "https://registry.example.test", options),
      {
        custody: f.store,
        now: () => elapsed,
        sleep: async (ms) => {
          elapsed += ms;
        },
        timeoutMs: 75_000,
      },
    );
    expect(fullReads).toBe(1);
    expect(versionReads).toBe(72);
    const retainedBytes = f
      .events()
      .filter((event) => event.kind === "READ_BODY")
      .reduce((total, event) => total + event.retained, 0);
    expect(retainedBytes).toBeLessThan(4 * 1024 * 1024);
    expect(f.events().find((event) => event.kind === "COHORT_READS_MATCHED").reads).toBe(144);
    const resources = f
      .events()
      .filter((event) => event.kind === "READ_RESPONSE" && event.resource)
      .map((event) => event.resource.kind);
    expect(resources.filter((kind) => kind === "tags")).toHaveLength(72);
    expect(resources.filter((kind) => kind === "version")).toHaveLength(72);
  });

  test.each(["wrong-name", "wrong-version", "null-manifest", "null-tags"])(
    "retains both responses but rejects a selected %s observation",
    async (failure) => {
      const f = fixture();
      const name = "@example/package";
      await expect(
        readRegistryPackage(
          name,
          async (url) =>
            String(url).includes("/dist-tags?")
              ? Response.json(failure === "null-tags" ? null : { latest: "1.0.0", canary: version })
              : Response.json(
                  failure === "null-manifest"
                    ? null
                    : {
                        name: failure === "wrong-name" ? "@example/other" : name,
                        version: failure === "wrong-version" ? "1.0.1-canary.3" : version,
                      },
                ),
          "https://registry.example.test",
          { custody: f.store, selectedVersion: version, revalidate: true },
        ),
      ).rejects.toThrow();
      expect(
        f.events().filter((event) => event.kind === "READ_BODY" && event.complete),
      ).toHaveLength(2);
    },
  );

  test("only a 404 means an absent selected version", async () => {
    const f = fixture();
    const current = await readRegistryPackage(
      "@example/package",
      async (url) =>
        String(url).includes("/dist-tags?")
          ? Response.json({ latest: "1.0.0" })
          : new Response(null, { status: 404 }),
      "https://registry.example.test",
      { custody: f.store, selectedVersion: version, revalidate: true },
    );
    expect(current).toEqual({ "dist-tags": { latest: "1.0.0" }, versions: {} });
    await expect(
      readRegistryPackage("@example/package", async () => Response.json(null)),
    ).rejects.toThrow("incomplete");
  });

  test("all receipt reads share one deadline and one read cap", async () => {
    const f = fixture();
    const cohort = freezeCanaryCohort(f.packages, f.store);
    let reads = 0;
    await expect(
      confirmCanaryCohort(
        cohort,
        reader((name) => {
          reads++;
          return Response.json(metadata(cohort.find((pkg) => pkg.name === name)!, false));
        }),
        { custody: f.store, maxReads: 3 },
      ),
    ).rejects.toThrow("read_limit");
    expect(reads).toBe(1);
    expect(f.events().filter((event) => event.kind === "READ_RESPONSE")).toHaveLength(2);
  });

  test.each(["latest", "integrity", "tag", "attestation", "predicate"] as const)(
    "never admits pins from a wrong %s receipt",
    async (field) => {
      const f = fixture();
      const cohort = freezeCanaryCohort(f.packages, f.store);
      let elapsed = 0;
      await expect(
        confirmCanaryCohort(
          cohort,
          reader((name) => {
            const current = metadata(cohort.find((pkg) => pkg.name === name)!);
            if (field === "latest") current["dist-tags"].latest = "1.1.0";
            if (field === "tag") current["dist-tags"].canary = "1.0.1-canary.3";
            if (field === "integrity") current.versions[version]!.dist.integrity = "sha512-wrong";
            if (field === "attestation")
              current.versions[version]!.dist.attestations.url = undefined as unknown as string;
            if (field === "predicate")
              current.versions[version]!.dist.attestations.provenance.predicateType =
                "https://example.test/wrong";
            return Response.json(current);
          }),
          {
            custody: f.store,
            now: () => elapsed,
            sleep: async (ms) => {
              elapsed += ms;
            },
            timeoutMs: 1000,
          },
        ),
      ).rejects.toThrow();
      expect(f.events().filter((event) => event.kind === "COHORT_READS_MATCHED")).toHaveLength(0);
    },
  );

  test("a valid selected response pair cannot settle after custody passes the deadline", async () => {
    const f = fixture();
    const cohort = freezeCanaryCohort(f.packages, f.store).slice(0, 1);
    let elapsed = 0;
    const read: typeof readRegistryPackage = async (...args) => {
      const value = await reader(() => Response.json(metadata(cohort[0]!)))(...args);
      elapsed = 1500;
      return value;
    };
    await expect(
      confirmCanaryCohort(cohort, read, { custody: f.store, now: () => elapsed, timeoutMs: 1000 }),
    ).rejects.toThrow("read_exceeded_deadline");
    expect(f.events().filter((event) => event.kind === "READ_BODY" && event.complete)).toHaveLength(
      2,
    );
    expect(f.events().filter((event) => event.kind === "COHORT_READS_MATCHED")).toHaveLength(0);
  });

  test("retains exact invalid body bytes before parsing and only allowlisted headers", async () => {
    const f = fixture();
    const body = "synthetic-invalid-json";
    await expect(
      readRegistryPackage(
        "@example/package",
        async () =>
          new Response(body, {
            headers: {
              "content-type": "application/json",
              authorization: "synthetic-secret-token",
              "set-cookie": "synthetic-cookie",
            },
          }),
        "https://registry.example.test",
        { custody: f.store },
      ),
    ).rejects.toThrow("invalid JSON");
    const recorded = f.events().find((event) => event.kind === "READ_BODY");
    expect(readFileSync(join(f.directory, recorded.body.file), "utf8")).toBe(body);
    expect(JSON.stringify(f.events())).not.toContain("synthetic-secret-token");
    expect(JSON.stringify(f.events())).not.toContain("synthetic-cookie");
    expect(statSync(f.directory).mode & 0o777).toBe(0o700);
    for (const file of readdirSync(f.directory))
      expect(statSync(join(f.directory, file)).mode & 0o777).toBe(0o600);
  });

  test("partial timeout bytes remain incomplete evidence", async () => {
    const f = fixture();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (++pulls === 1) controller.enqueue(new TextEncoder().encode('{"synthetic":'));
        else controller.error(new DOMException("synthetic body timeout", "TimeoutError"));
      },
    });
    await expect(
      readRegistryPackage(
        "@example/package",
        async () => new Response(body),
        "https://registry.example.test",
        { custody: f.store },
      ),
    ).rejects.toThrow("synthetic body timeout");
    expect(f.events().find((event) => event.kind === "READ_BODY").complete).toBe(false);
    expect(f.events().find((event) => event.kind === "READ_BODY").category).toBe("request_timeout");
    expect(f.events().find((event) => event.kind === "READ_BODY").retained).toBeGreaterThan(0);
  });

  test("oversize bodies retain truthful truncation and never become parsed metadata", async () => {
    const f = fixture();
    await expect(
      readRegistryPackage(
        "@example/package",
        async () => new Response(new Uint8Array(CANARY_RESPONSE_BYTES + 1)),
        "https://registry.example.test",
        { custody: f.store },
      ),
    ).rejects.toThrow("exceeds custody bound");
    const event = f.events().find((entry) => entry.kind === "READ_BODY");
    expect(event.retained).toBe(CANARY_RESPONSE_BYTES);
    expect(event.received).toBe(CANARY_RESPONSE_BYTES + 1);
    expect(event.truncated).toBe(true);
    expect(event.complete).toBe(false);
  });

  test("an ignored request signal still produces a bounded read failure", async () => {
    const f = fixture();
    const never = new Promise<Response>(() => {});
    await expect(
      readRegistryPackage("@example/package", () => never, "https://registry.example.test", {
        custody: f.store,
        signal: AbortSignal.timeout(10),
      }),
    ).rejects.toThrow("timed out");
    expect(f.events().map((event) => event.kind)).toEqual(["READ_FAILED"]);
  });

  test("a stalled response body is bounded without inventing complete custody", async () => {
    const f = fixture();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"synthetic":'));
      },
    });
    await expect(
      readRegistryPackage(
        "@example/package",
        async () => new Response(body),
        "https://registry.example.test",
        { custody: f.store, signal: AbortSignal.timeout(10) },
      ),
    ).rejects.toThrow("timed out");
    const event = f.events().find((entry) => entry.kind === "READ_BODY");
    expect(event.complete).toBe(false);
    expect(event.retained).toBeGreaterThan(0);
    expect(event.category).toBe("request_timeout");
  });

  test("receipt records cannot replace the admitted source", () => {
    const f = fixture();
    expect(() => f.store.record("READ_RESPONSE", { identity: { source: "b".repeat(40) } })).toThrow(
      "admitted identity",
    );
    expect(
      () =>
        new CanaryReceiptStore(join(f.root, "bad-source"), {
          ...identity,
          workflowSource: "b".repeat(40),
        }),
    ).toThrow("source identity");
  });
});

describe("fresh complete-cohort qualification", () => {
  test.each(["latest", "canary", "integrity"] as const)(
    "refuses pins when an earlier match changes %s during delayed visibility",
    async (field) => {
      const f = fixture();
      const cohort = freezeCanaryCohort(f.packages, f.store);
      let writes = 0,
        delayedReads = 0,
        changed = false,
        elapsed = 0;
      await expect(
        publishAndVerifyCanaryCohort(cohort, f.store, "synthetic-token", {
          publish: (async () => {
            writes++;
            return accepted();
          }) as typeof libnpmpublish.publish,
          read: reader((name) => {
            const pkg = cohort.find((entry) => entry.name === name)!;
            if (writes !== cohort.length) return Response.json(metadata(pkg, false));
            if (name === names[3] && ++delayedReads === 1)
              return Response.json(metadata(pkg, false));
            if (name === names[3]) changed = true;
            const current = metadata(pkg);
            if (name === names[0] && changed) {
              if (field === "latest") current["dist-tags"].latest = "1.1.0";
              if (field === "canary") current["dist-tags"].canary = "1.0.1-canary.3";
              if (field === "integrity") current.versions[version]!.dist.integrity = "sha512-wrong";
            }
            return Response.json(current);
          }),
          now: () => elapsed,
          sleep: async (ms) => {
            elapsed += ms;
          },
          timeoutMs: 5000,
        }),
      ).rejects.toThrow();
      expect(changed).toBe(true);
      expect(writes).toBe(4);
      expect(f.events().filter((event) => event.kind === "COHORT_READS_MATCHED")).toHaveLength(0);
      expect(f.events().filter((event) => event.kind === "SITE_PINS_WRITTEN")).toHaveLength(0);
    },
  );

  test("final qualification cannot reset the shared read quota", async () => {
    const f = fixture();
    const cohort = freezeCanaryCohort(f.packages, f.store);
    let writes = 0,
      receiptReads = 0;
    await expect(
      publishAndVerifyCanaryCohort(cohort, f.store, "synthetic-token", {
        publish: (async () => {
          writes++;
          return accepted();
        }) as typeof libnpmpublish.publish,
        read: reader((name) => {
          const final = writes === cohort.length;
          if (final) receiptReads++;
          return Response.json(metadata(cohort.find((pkg) => pkg.name === name)!, final));
        }),
        maxReads: 15,
      }),
    ).rejects.toThrow("Final canary cohort");
    expect(writes).toBe(4);
    expect(receiptReads).toBe(4);
    expect(f.events().filter((event) => event.kind === "COHORT_READS_MATCHED")).toHaveLength(0);
  });

  test("final qualification remains inside the original monotonic deadline", async () => {
    const f = fixture();
    const cohort = freezeCanaryCohort(f.packages, f.store);
    let writes = 0,
      firstPackageReads = 0,
      elapsed = 0;
    await expect(
      publishAndVerifyCanaryCohort(cohort, f.store, "synthetic-token", {
        publish: (async () => {
          writes++;
          return accepted();
        }) as typeof libnpmpublish.publish,
        read: reader((name) => {
          const final = writes === cohort.length;
          if (final && name === names[0] && ++firstPackageReads === 2) elapsed = 1001;
          return Response.json(metadata(cohort.find((pkg) => pkg.name === name)!, final));
        }),
        now: () => elapsed,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow();
    expect(firstPackageReads).toBe(2);
    expect(writes).toBe(4);
    expect(f.events().filter((event) => event.kind === "COHORT_READS_MATCHED")).toHaveLength(0);
  });

  test("actual final-response custody failure prevents pins", async () => {
    const f = fixture();
    const cohort = freezeCanaryCohort(f.packages, f.store);
    const retained = join(f.root, "retained-final-response");
    let writes = 0,
      firstPackageReads = 0,
      moved = false;
    await expect(
      publishAndVerifyCanaryCohort(cohort, f.store, "synthetic-token", {
        publish: (async () => {
          writes++;
          return accepted();
        }) as typeof libnpmpublish.publish,
        read: reader((name) => {
          const final = writes === cohort.length;
          if (final && name === names[0] && ++firstPackageReads === 2) {
            renameSync(f.directory, retained);
            moved = true;
          }
          return Response.json(metadata(cohort.find((pkg) => pkg.name === name)!, final));
        }),
      }),
    ).rejects.toThrow();
    expect(moved).toBe(true);
    expect(writes).toBe(4);
    expect(f.events(retained).filter((event) => event.kind === "WRITE_ACKNOWLEDGED")).toHaveLength(
      4,
    );
    expect(
      f.events(retained).filter((event) => event.kind === "COHORT_READS_MATCHED"),
    ).toHaveLength(0);
  });

  test("every final match is reread within the same exact quota", async () => {
    const f = fixture();
    const cohort = freezeCanaryCohort(f.packages, f.store);
    let writes = 0;
    const receiptReads = new Map<string, number>();
    const pins = await publishAndVerifyCanaryCohort(cohort, f.store, "synthetic-token", {
      publish: (async () => {
        writes++;
        return accepted();
      }) as typeof libnpmpublish.publish,
      read: reader((name) => {
        const final = writes === cohort.length;
        if (final) receiptReads.set(name, (receiptReads.get(name) ?? 0) + 1);
        return Response.json(metadata(cohort.find((pkg) => pkg.name === name)!, final));
      }),
      maxReads: 16,
    });
    expect(pins).toEqual(Object.fromEntries(names.map((name) => [name, version])));
    expect([...receiptReads.entries()]).toEqual(names.map((name) => [name, 2]));
    const matched = f.events().find((event) => event.kind === "COHORT_READS_MATCHED");
    expect(matched.reads).toBe(16);
    expect(matched.freshCompleteCohort).toBe(true);
  });
});
