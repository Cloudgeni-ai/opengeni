import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANARY_RECEIPT_FILES, CanaryReceiptStore } from "./canary-publication-receipts";
import {
  CANARY_VISIBILITY_TIMEOUT_MS,
  CanaryVisibilityPending,
  confirmCanaryCohort,
  readRegistryPackage,
} from "./publish-canary";

const roots: string[] = [];
const version = "1.0.1-canary.7";
const integrity = `sha512-${createHash("sha512").update("synthetic archive").digest("base64")}`;
const dist = {
  integrity,
  attestations: {
    url: "https://registry.example.test/attestation",
    provenance: { predicateType: "https://slsa.dev/provenance/v1" },
  },
};
function archive(name = "@example/package") {
  return { name, version, previousLatest: "1.0.0", integrity, archiveBytes: 17 };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("complete-cohort receipts fit the unchanged custody bound without fetching unrelated version history", async () => {
  const root = mkdtempSync(join(tmpdir(), "canary-version-receipts-"));
  roots.push(root);
  const directory = join(root, "receipts");
  const custody = new CanaryReceiptStore(directory, {
    source: "a".repeat(40),
    workflowSource: "a".repeat(40),
    runId: "7",
    attempt: "1",
  });
  const packages = Array.from({ length: 32 }, (_, index) => archive(`@example/package-${index}`));
  let requests = 0,
    fullHistories = 0;
  const read: typeof readRegistryPackage = (name, _request, _base, options) =>
    readRegistryPackage(
      name,
      async (url, init) => {
        requests++;
        expect(init?.method).toBe("GET");
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/dist-tags")) return Response.json({ latest: "1.0.0", canary: version });
        if (path.endsWith(`/${version}`)) return Response.json({ name, version, dist });
        fullHistories++;
        return Response.json({
          "dist-tags": { latest: "1.0.0", canary: version },
          versions: { [version]: { dist } },
          unrelatedHistory: "x".repeat(1_200_000),
        });
      },
      "https://registry.example.test",
      options,
    );
  await confirmCanaryCohort(packages, read, { custody });
  expect(fullHistories).toBe(0);
  expect(requests).toBe(128);
  const records = readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(readFileSync(join(directory, file), "utf8")));
  const matched = records.filter((record) => record.kind === "COHORT_READS_MATCHED");
  expect(matched).toHaveLength(1);
  expect(matched[0].observations).toBe(64);
  expect(matched[0].freshCompleteCohort).toBe(true);
  // Only the final complete-cohort reread retains response custody.
  expect(records.filter((record) => record.kind === "READ_RESPONSE")).toHaveLength(64);
  expect(
    records
      .filter((record) => record.kind === "READ_BODY")
      .reduce((sum, record) => sum + record.retained, 0),
  ).toBeLessThan(64 * 1024 * 1024);
});

test("waiting reads keep one observation each so a long wait stays within the custody bound", async () => {
  const root = mkdtempSync(join(tmpdir(), "canary-version-receipts-"));
  roots.push(root);
  const directory = join(root, "receipts");
  const custody = new CanaryReceiptStore(directory, {
    source: "a".repeat(40),
    workflowSource: "a".repeat(40),
    runId: "7",
    attempt: "2",
  });
  const packages = Array.from({ length: 64 }, (_, index) => archive(`@example/package-${index}`));
  let elapsed = 0;
  const read: typeof readRegistryPackage = (name, _request, _base, options) =>
    readRegistryPackage(
      name,
      async (url) =>
        String(url).includes("/dist-tags")
          ? Response.json({ latest: "1.0.0", canary: version })
          : new Response(null, { status: 404 }),
      "https://registry.example.test",
      options,
    );
  await expect(
    confirmCanaryCohort(packages, read, {
      custody,
      now: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms;
      },
    }),
  ).rejects.toBeInstanceOf(CanaryVisibilityPending);
  expect(elapsed).toBe(CANARY_VISIBILITY_TIMEOUT_MS);
  const files = readdirSync(directory);
  expect(files.filter((file) => file.endsWith(".body"))).toHaveLength(0);
  expect(files.length).toBeLessThan(CANARY_RECEIPT_FILES);
});

test("transient registry failures keep waiting; client errors still fail closed", async () => {
  let elapsed = 0,
    versionReads = 0;
  const responses = [
    () => new Response("unavailable", { status: 503 }),
    () => new Response("slow down", { status: 429 }),
    () => {
      throw new TypeError("synthetic transport failure");
    },
  ];
  const read: typeof readRegistryPackage = (name, _request, _base, options) =>
    readRegistryPackage(
      name,
      async (url) => {
        if (String(url).includes("/dist-tags"))
          return Response.json({ latest: "1.0.0", canary: version });
        return (responses[versionReads++] ?? (() => Response.json({ name, version, dist })))();
      },
      "https://registry.example.test",
      options,
    );
  await confirmCanaryCohort([archive()], read, {
    now: () => elapsed,
    sleep: async (ms) => {
      elapsed += ms;
    },
  });
  expect(versionReads).toBe(5);
  const forbidden: typeof readRegistryPackage = (name, _request, _base, options) =>
    readRegistryPackage(
      name,
      async (url) =>
        String(url).includes("/dist-tags")
          ? Response.json({ latest: "1.0.0", canary: version })
          : new Response("forbidden", { status: 403 }),
      "https://registry.example.test",
      options,
    );
  await expect(confirmCanaryCohort([archive()], forbidden)).rejects.toThrow("failed: 403");
});

test("a later canary publication's tag does not block a re-run confirmation", async () => {
  for (const [canary, settles] of [
    ["1.0.1-canary.8", true],
    ["1.0.2-canary.0", true],
    ["1.0.1-canary.6", false],
    ["1.0.1", false],
  ] as const) {
    let elapsed = 0;
    const read: typeof readRegistryPackage = (name, _request, _base, options) =>
      readRegistryPackage(
        name,
        async (url) =>
          String(url).includes("/dist-tags")
            ? Response.json({ latest: "1.0.0", canary })
            : Response.json({ name, version, dist }),
        "https://registry.example.test",
        options,
      );
    const confirmation = confirmCanaryCohort([archive()], read, {
      now: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms;
      },
      timeoutMs: 60_000,
    });
    if (settles) await confirmation;
    else await expect(confirmation).rejects.toThrow("canary_tag_pending");
  }
});

test.each(["name", "version"] as const)(
  "a targeted receipt rejects a mismatched %s identity",
  async (field) => {
    const read: typeof readRegistryPackage = (name, _request, _base, options) =>
      readRegistryPackage(
        name,
        async (url) => {
          if (String(url).includes("/dist-tags"))
            return Response.json({ latest: "1.0.0", canary: version });
          return Response.json({
            name: field === "name" ? "@example/other" : name,
            version: field === "version" ? "1.0.1-canary.8" : version,
            dist,
          });
        },
        "https://registry.example.test",
        options,
      );
    await expect(confirmCanaryCohort([archive()], read)).rejects.toThrow("identity");
  },
);

test.each([null, [], { latest: 4 }, { canary: null }, false].map((tags) => ({ tags })))(
  "invalid tags fail before version dispatch: %j",
  async ({ tags }) => {
    let requests = 0;
    await expect(
      readRegistryPackage(
        "@example/package",
        async () => {
          requests++;
          return Response.json(tags);
        },
        "https://registry.example.test",
        { receiptVersion: version },
      ),
    ).rejects.toThrow("tags");
    expect(requests).toBe(1);
  },
);

test("a hidden selected version stays pending within the original elapsed budget", async () => {
  let requests = 0,
    elapsed = 0;
  const read: typeof readRegistryPackage = (name, _request, _base, options) =>
    readRegistryPackage(
      name,
      async (url) => {
        requests++;
        return String(url).includes("/dist-tags")
          ? Response.json({ latest: "1.0.0", canary: version })
          : new Response(null, { status: 404 });
      },
      "https://registry.example.test",
      options,
    );
  await expect(
    confirmCanaryCohort([archive()], read, {
      now: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms;
      },
      timeoutMs: 1000,
    }),
  ).rejects.toThrow("version_pending");
  expect(requests).toBe(2);
  expect(elapsed).toBe(1000);
});

test("a new package keeps its absent latest tag through both qualification passes", async () => {
  let requests = 0;
  const read: typeof readRegistryPackage = (name, _request, _base, options) =>
    readRegistryPackage(
      name,
      async (url) => {
        requests++;
        return String(url).includes("/dist-tags")
          ? Response.json({ canary: version })
          : Response.json({ name, version, dist });
      },
      "https://registry.example.test",
      options,
    );
  const pkg = { ...archive(), previousLatest: undefined };
  await confirmCanaryCohort([pkg], read);
  expect(requests).toBe(4);
});

test("a large cohort that becomes visible late qualifies within one window", async () => {
  const packages = Array.from({ length: 30 }, (_, index) => archive(`@example/package-${index}`));
  let elapsed = 0;
  const requests: number[] = [];
  const read: typeof readRegistryPackage = (name, _request, _base, options) =>
    readRegistryPackage(
      name,
      async (url) => {
        requests.push(elapsed);
        return String(url).includes("/dist-tags")
          ? Response.json({ latest: "1.0.0", canary: version })
          : elapsed < 150_000
            ? new Response(null, { status: 404 })
            : Response.json({ name, version, dist });
      },
      "https://registry.example.test",
      options,
    );
  await confirmCanaryCohort(packages, read, {
    now: () => elapsed,
    sleep: async (ms) => {
      elapsed += ms;
    },
  });
  expect(requests.some((time) => time >= 150_000)).toBe(true);
  // Backoff polls at 0, 5, 15, 35, 75, 135 and 195 seconds, then one final pass.
  expect(requests.length).toBe(30 * 2 * 8);
  expect(elapsed).toBe(195_000);
});

test("early matches are rechecked after delayed packages appear", async () => {
  const packages = Array.from({ length: 30 }, (_, index) => archive(`@example/package-${index}`));
  let elapsed = 0,
    requests = 0,
    firstPackageReads = 0;
  const read: typeof readRegistryPackage = (name, _request, _base, options) =>
    readRegistryPackage(
      name,
      async (url) => {
        requests++;
        if (String(url).includes("/dist-tags")) {
          if (name === packages[0]!.name) firstPackageReads++;
          return Response.json({
            latest: firstPackageReads > 1 && name === packages[0]!.name ? "2.0.0" : "1.0.0",
            canary: version,
          });
        }
        return name !== packages[0]!.name && elapsed < 150_000
          ? new Response(null, { status: 404 })
          : Response.json({ name, version, dist });
      },
      "https://registry.example.test",
      options,
    );
  await expect(
    confirmCanaryCohort(packages, read, {
      now: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms;
      },
    }),
  ).rejects.toThrow("Stable tag changed");
  expect(firstPackageReads).toBe(2);
  expect(elapsed).toBeGreaterThanOrEqual(150_000);
  expect(elapsed).toBeLessThan(600_000);
});

test("a hidden large cohort keeps waiting for the whole window, then names what is missing", async () => {
  const packages = Array.from({ length: 30 }, (_, index) => archive(`@example/package-${index}`));
  let elapsed = 0,
    requests = 0;
  const read: typeof readRegistryPackage = (name, _request, _base, options) =>
    readRegistryPackage(
      name,
      async (url) => {
        requests++;
        return String(url).includes("/dist-tags")
          ? Response.json({ latest: "1.0.0", canary: version })
          : new Response(null, { status: 404 });
      },
      "https://registry.example.test",
      options,
    );
  await expect(
    confirmCanaryCohort(packages, read, {
      now: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms;
      },
    }),
  ).rejects.toThrow("@example/package-29@1.0.1-canary.7 (version_pending) after 1800s");
  expect(elapsed).toBe(CANARY_VISIBILITY_TIMEOUT_MS);
  // 5s, 10s, 20s, 40s, then one poll a minute: 33 polls of two GETs each.
  expect(requests).toBe(30 * 2 * 33);
});

// Observed registry behavior: npm answers each write with 202 and processes it
// later. Most versions appear within minutes; the largest archives took 10-18
// minutes in October 2026.
test("a few packages that stay hidden for many minutes still qualify in one window", async () => {
  const packages = Array.from({ length: 31 }, (_, index) => archive(`@example/package-${index}`));
  const late = new Set([packages[7]!.name, packages[29]!.name]);
  let elapsed = 0,
    requests = 0;
  const read: typeof readRegistryPackage = (name, _request, _base, options) =>
    readRegistryPackage(
      name,
      async (url) => {
        requests++;
        return String(url).includes("/dist-tags")
          ? Response.json({ latest: "1.0.0", canary: version })
          : late.has(name) && elapsed < 1_080_000
            ? new Response(null, { status: 404 })
            : Response.json({ name, version, dist });
      },
      "https://registry.example.test",
      options,
    );
  await confirmCanaryCohort(packages, read, {
    now: () => elapsed,
    sleep: async (ms) => {
      elapsed += ms;
    },
  });
  // Seen on the first poll after 18 minutes; only the two late packages are polled meanwhile.
  expect(elapsed).toBe(1_095_000);
  expect(requests).toBe(31 * 2 + 21 * 2 * 2 + 31 * 2);
});

test("the largest admitted cohort qualifies after a delayed first appearance", async () => {
  const packages = Array.from({ length: 64 }, (_, index) => archive(`@example/package-${index}`));
  let elapsed = 0,
    requests = 0;
  const read: typeof readRegistryPackage = (name, _request, _base, options) =>
    readRegistryPackage(
      name,
      async (url) => {
        requests++;
        return String(url).includes("/dist-tags")
          ? Response.json({ latest: "1.0.0", canary: version })
          : elapsed < 60_000
            ? new Response(null, { status: 404 })
            : Response.json({ name, version, dist });
      },
      "https://registry.example.test",
      options,
    );
  await confirmCanaryCohort(packages, read, {
    now: () => elapsed,
    sleep: async (ms) => {
      elapsed += ms;
    },
  });
  expect(elapsed).toBeGreaterThanOrEqual(60_000);
  expect(requests).toBe(64 * 2 * 6);
});

test.each(
  [
    { count: 30, delayMs: 375, timeoutRequest: null },
    { count: 30, delayMs: 500, timeoutRequest: null },
    { count: 1, delayMs: 4500, timeoutRequest: null },
    { count: 30, delayMs: 0, timeoutRequest: "tags" },
    { count: 30, delayMs: 0, timeoutRequest: "version" },
    { count: 30, delayMs: 375, timeoutRequest: "tags" },
    { count: 30, delayMs: 375, timeoutRequest: "version" },
    {
      count: 30,
      delayMs: 0,
      timeoutRequest: null,
      slowRequest: "tags",
      slowMs: 9000,
    },
    {
      count: 30,
      delayMs: 0,
      timeoutRequest: null,
      slowRequest: "version",
      slowMs: 9000,
    },
    {
      count: 30,
      delayMs: 375,
      timeoutRequest: null,
      slowRequest: "tags",
      slowMs: 9000,
    },
    {
      count: 30,
      delayMs: 0,
      timeoutRequest: null,
      slowRequest: "tags",
      slowMs: 9000,
      repeatSlow: true,
    },
    {
      count: 30,
      delayMs: 0,
      timeoutRequest: null,
      slowRequest: "version",
      slowMs: 9000,
      repeatSlow: true,
    },
    {
      count: 30,
      delayMs: 0,
      timeoutRequest: null,
      slowRequest: "tags",
      slowMs: 9000,
      repeatSlow: true,
      earlySlowMatch: true,
    },
  ].map((scenario) => ({
    slowRequest: null as string | null,
    slowMs: 0,
    repeatSlow: false,
    earlySlowMatch: false,
    ...scenario,
  })),
)("late visibility survives response latency and transient timeouts: %j", async (scenario) => {
  let elapsed = 0,
    requests = 0,
    timeouts = 0,
    slowReads = 0,
    active = 0,
    peak = 0;
  const timers: { at: number; resolve: () => void }[] = [];
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      timers.push({ at: elapsed + ms, resolve });
    });
  const packages = Array.from({ length: scenario.count }, (_, index) =>
    archive(`@example/package-${index}`),
  );
  const read: typeof readRegistryPackage = (name, _request, _base, options) =>
    readRegistryPackage(
      name,
      async (url) => {
        requests++;
        active++;
        peak = Math.max(peak, active);
        try {
          const requestKind = String(url).includes("/dist-tags") ? "tags" : "version";
          if (scenario.timeoutRequest === requestKind && timeouts === 0) {
            timeouts++;
            await sleep(10_000 - (requestKind === "version" ? scenario.delayMs : 0));
            throw new DOMException("Synthetic receipt timeout", "TimeoutError");
          }
          const isSlow =
            name === packages[0]!.name &&
            scenario.slowRequest === requestKind &&
            (scenario.repeatSlow || slowReads === 0);
          if (isSlow) slowReads++;
          await sleep(isSlow ? scenario.slowMs : scenario.delayMs);
          return String(url).includes("/dist-tags")
            ? Response.json({ latest: "1.0.0", canary: version })
            : elapsed < 150_000 && !(scenario.earlySlowMatch && name === packages[0]!.name)
              ? new Response(null, { status: 404 })
              : Response.json({ name, version, dist });
        } finally {
          active--;
        }
      },
      "https://registry.example.test",
      options,
    );
  let settled = false;
  const confirmation = confirmCanaryCohort(packages, read, {
    now: () => elapsed,
    sleep,
  });
  confirmation.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let steps = 0; steps < 5000; steps++) {
    if (settled) break;
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (settled) break;
    expect(timers.length).toBeGreaterThan(0);
    timers.sort((a, b) => a.at - b.at);
    elapsed = timers[0]!.at;
    while (timers[0]?.at === elapsed) timers.shift()!.resolve();
  }
  expect(settled).toBe(true);
  await confirmation;
  expect(elapsed).toBeGreaterThanOrEqual(150_000);
  expect(elapsed).toBeLessThan(600_000);
  expect(requests).toBeLessThanOrEqual(scenario.count * 2 * 12);
  expect(peak).toBeLessThanOrEqual(4);
  expect(timeouts).toBe(scenario.timeoutRequest === null ? 0 : 1);
  if (scenario.slowRequest !== null) expect(slowReads).toBeGreaterThan(0);
  if (scenario.earlySlowMatch) expect(slowReads).toBeGreaterThanOrEqual(2);
});

test("invalid selected version paths fail before any registry request", async () => {
  let requests = 0;
  await expect(
    readRegistryPackage(
      "@example/package",
      async () => {
        requests++;
        return Response.json({});
      },
      "https://registry.example.test",
      { receiptVersion: `${version}/other` },
    ),
  ).rejects.toThrow("identity");
  expect(requests).toBe(0);
});

test("both selected requests use the same deadline signal and read-only fresh envelope", async () => {
  const signal = AbortSignal.timeout(1000);
  let requests = 0,
    additionalCharges = 0;
  await readRegistryPackage(
    "@example/package",
    async (url, init) => {
      requests++;
      expect(init?.signal).toBe(signal);
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      expect(init?.redirect).toBe("manual");
      expect(init?.credentials).toBe("omit");
      expect(init?.cache).toBe("no-store");
      expect(init?.headers).toEqual({ accept: "application/json", "cache-control": "no-cache" });
      return String(url).includes("/dist-tags")
        ? Response.json({ latest: "1.0.0", canary: version })
        : Response.json({ name: "@example/package", version, dist });
    },
    "https://registry.example.test",
    {
      revalidate: true,
      receiptVersion: version,
      signal,
      beforeAdditionalRequest: () => {
        additionalCharges++;
      },
    },
  );
  expect(requests).toBe(2);
  expect(additionalCharges).toBe(1);
});

test("an abort after tag custody cannot dispatch a new version request", async () => {
  const controller = new AbortController();
  let requests = 0,
    additionalCharges = 0;
  await expect(
    readRegistryPackage(
      "@example/package",
      async () => {
        requests++;
        return Response.json({ latest: "1.0.0", canary: version });
      },
      "https://registry.example.test",
      {
        receiptVersion: version,
        signal: controller.signal,
        beforeAdditionalRequest: () => {
          additionalCharges++;
        },
        custody: {
          record: () => ({ file: "synthetic-record", bytes: 0, sha256: "a".repeat(64) }),
          capture: async (_name, response) => {
            const body = Buffer.from(await response.arrayBuffer());
            controller.abort(new DOMException("synthetic receipt deadline", "TimeoutError"));
            return body;
          },
        },
      },
    ),
  ).rejects.toThrow("synthetic receipt deadline");
  expect(requests).toBe(1);
  expect(additionalCharges).toBe(0);
});

test("an ignored version request cannot renew the tags request's timeout", async () => {
  let requests = 0;
  await expect(
    readRegistryPackage(
      "@example/package",
      async (url) => {
        requests++;
        return String(url).includes("/dist-tags")
          ? Response.json({ latest: "1.0.0", canary: version })
          : new Promise<Response>(() => {});
      },
      "https://registry.example.test",
      {
        receiptVersion: version,
        signal: AbortSignal.timeout(10),
      },
    ),
  ).rejects.toThrow("timed out");
  expect(requests).toBe(2);
});

function stagedRead(state: { approved: boolean; requests: number }): typeof readRegistryPackage {
  return (name, _request, _base, options) =>
    readRegistryPackage(
      name,
      async (url) => {
        state.requests++;
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/dist-tags")) {
          return Response.json(
            state.approved ? { latest: "0.0.0-stage", canary: version } : { latest: "0.0.0-stage" },
          );
        }
        return state.approved
          ? Response.json({ name, version, dist })
          : new Response(null, { status: 404 });
      },
      "https://registry.example.test",
      options,
    );
}

test("a first publication held in npm staged publishing asks for maintainer approval at once", async () => {
  const state = { approved: false, requests: 0 };
  const first = { ...archive("@example/new-package"), previousLatest: undefined };
  await expect(confirmCanaryCohort([first], stagedRead(state))).rejects.toThrow(
    "npm staged publishing holds the first publication of @example/new-package@1.0.1-canary.7",
  );
  expect(state.requests).toBe(2);
});

test("an approved staged first publication confirms under npm's placeholder latest tag", async () => {
  const state = { approved: true, requests: 0 };
  const first = { ...archive("@example/new-package"), previousLatest: undefined };
  await confirmCanaryCohort([first], stagedRead(state));
});

test("the staged placeholder never excuses a moved stable tag on an existing package", async () => {
  const state = { approved: true, requests: 0 };
  await expect(confirmCanaryCohort([archive()], stagedRead(state))).rejects.toThrow(
    "Stable tag changed",
  );
});
