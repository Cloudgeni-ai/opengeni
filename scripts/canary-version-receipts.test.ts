import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CanaryReceiptStore } from "./canary-publication-receipts";
import { confirmCanaryCohort, readRegistryPackage } from "./publish-canary";

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
  expect(records.filter((record) => record.kind === "COHORT_READS_MATCHED")[0].reads).toBe(128);
  expect(
    records
      .filter((record) => record.kind === "READ_BODY")
      .reduce((sum, record) => sum + record.retained, 0),
  ).toBeLessThan(64 * 1024 * 1024);
});

test("each actual receipt request shares the original quota, including a version request", async () => {
  let requests = 0;
  const read: typeof readRegistryPackage = (name, _request, _base, options) =>
    readRegistryPackage(
      name,
      async () => {
        requests++;
        return Response.json({ latest: "1.0.0", canary: version });
      },
      "https://registry.example.test",
      options,
    );
  await expect(confirmCanaryCohort([archive()], read, { maxReads: 1 })).rejects.toThrow(
    "read quota",
  );
  expect(requests).toBe(1);
});

test("the final cohort cannot borrow another request beyond the original quota", async () => {
  let requests = 0;
  const read: typeof readRegistryPackage = (name, _request, _base, options) =>
    readRegistryPackage(
      name,
      async (url) => {
        requests++;
        return String(url).includes("/dist-tags")
          ? Response.json({ latest: "1.0.0", canary: version })
          : Response.json({ name, version, dist });
      },
      "https://registry.example.test",
      options,
    );
  await expect(confirmCanaryCohort([archive()], read, { maxReads: 3 })).rejects.toThrow(
    "read quota",
  );
  expect(requests).toBe(3);
});

test("later final batches cannot dispatch first requests beyond the shared quota", async () => {
  let requests = 0;
  const read: typeof readRegistryPackage = (name, _request, _base, options) =>
    readRegistryPackage(
      name,
      async (url) => {
        requests++;
        return String(url).includes("/dist-tags")
          ? Response.json({ latest: "1.0.0", canary: version })
          : Response.json({ name, version, dist });
      },
      "https://registry.example.test",
      options,
    );
  const packages = Array.from({ length: 8 }, (_, index) => archive(`@example/package-${index}`));
  await expect(confirmCanaryCohort(packages, read, { maxReads: 24 })).rejects.toThrow();
  expect(requests).toBe(24);
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

test("a large cohort can become visible late without spending its final read reserve", async () => {
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
  expect(requests.length).toBeLessThanOrEqual(256);
  expect(elapsed).toBeLessThan(180_000);
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
  expect(elapsed).toBeLessThan(180_000);
  expect(requests).toBeLessThanOrEqual(256);
});

test("a hidden large cohort fails within the original deadline and read quota", async () => {
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
  ).rejects.toThrow("read_limit");
  expect(elapsed).toBeGreaterThanOrEqual(150_000);
  expect(elapsed).toBeLessThanOrEqual(180_000);
  expect(requests).toBeLessThanOrEqual(256);
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
