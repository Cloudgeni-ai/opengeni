import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createKubernetesFixtureOpenAPI,
  kubernetesFixtureOpenAPI,
} from "./queue-demand-kubernetes-fixture";

const schemaUrl =
  "https://raw.githubusercontent.com/kubernetes/kubernetes/v1.34.0/api/openapi-spec/swagger.json";
const schemaSha256 = "d3b0cdc2fda15c753206d25ab459dc7c12df64e2fd652b6809687471ea751c37";
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function rawSchema(): Promise<Uint8Array> {
  // Reuse the same verified prerequisite as real Helm, including explicit offline input.
  expect((await kubernetesFixtureOpenAPI()).byteLength).toBeGreaterThan(0);
  const path =
    process.env.OPENGENI_KUBERNETES_FIXTURE_SCHEMA ??
    join(tmpdir(), `opengeni-kubernetes-openapi-v1.34.0-${schemaSha256}`, "swagger.json");
  return new Uint8Array(await readFile(path));
}

async function owned<T>(control: (directory: string, bytes: Uint8Array) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "opengeni-schema-cache-test-"));
  try {
    const bytes = await rawSchema();
    expect(bytes.byteLength).toBe(3828201);
    expect(digest(bytes)).toBe(schemaSha256);
    return await control(directory, bytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("pinned Kubernetes fixture uses an explicit verified offline input without HTTP", async () => {
  await owned(async (directory, bytes) => {
    const path = join(directory, "local.json");
    await writeFile(path, bytes);
    let requests = 0;
    const load = createKubernetesFixtureOpenAPI({
      schemaPath: path,
      request: async () => {
        requests++;
        throw new Error("Offline input must not request HTTP");
      },
    });
    expect(await load()).toEqual(await kubernetesFixtureOpenAPI());
    expect(requests).toBe(0);
  });
});

test("pinned Kubernetes fixture persists exact raw bytes and warm cache uses no HTTP", async () => {
  await owned(async (directory, bytes) => {
    let requests = 0;
    const load = createKubernetesFixtureOpenAPI({
      schemaPath: null,
      cacheDirectory: directory,
      request: async (url, options) => {
        requests++;
        expect(url).toBe(schemaUrl);
        expect(options.redirect).toBe("error");
        expect(options.headers).toBeUndefined();
        expect(options.signal).toBeInstanceOf(AbortSignal);
        return new Response(Uint8Array.from(bytes));
      },
    });
    const encoded = await load();
    expect(requests).toBe(1);
    expect(await readFile(join(directory, "swagger.json"))).toEqual(Buffer.from(bytes));
    expect(await readdir(directory)).toEqual(["swagger.json"]);
    const warm = createKubernetesFixtureOpenAPI({
      schemaPath: null,
      cacheDirectory: directory,
      request: async () => {
        requests++;
        throw new Error("Warm cache must not request HTTP");
      },
    });
    expect(await warm()).toEqual(encoded);
    expect(requests).toBe(1);
  });
});

test("pinned Kubernetes fixture rejects corrupt cache without fetching or overwriting it", async () => {
  await owned(async (directory, bytes) => {
    const corrupt = Uint8Array.from(bytes);
    corrupt[0] ^= 1;
    const path = join(directory, "swagger.json");
    await writeFile(path, corrupt);
    let requests = 0;
    const load = createKubernetesFixtureOpenAPI({
      schemaPath: null,
      cacheDirectory: directory,
      request: async () => {
        requests++;
        throw new Error("Corrupt cache must fail closed");
      },
    });
    await expect(load()).rejects.toThrow("checksum mismatch");
    expect(requests).toBe(0);
    expect(await readFile(path)).toEqual(Buffer.from(corrupt));
    await writeFile(path, bytes);
    expect(await load()).toEqual(await kubernetesFixtureOpenAPI());
    expect(requests).toBe(0);
  });
});

test("pinned Kubernetes fixture missing explicit input fails closed and a corrected input recovers", async () => {
  await owned(async (directory, bytes) => {
    const path = join(directory, "missing.json");
    let requests = 0;
    const load = createKubernetesFixtureOpenAPI({
      schemaPath: path,
      cacheDirectory: directory,
      request: async () => {
        requests++;
        throw new Error("Missing explicit input must not fall back");
      },
    });
    await expect(load()).rejects.toThrow("ENOENT");
    expect(requests).toBe(0);
    expect(await readdir(directory)).toEqual([]);
    await writeFile(path, bytes);
    expect(await load()).toEqual(await kubernetesFixtureOpenAPI());
    expect(requests).toBe(0);
  });
});

test("pinned Kubernetes fixture rejects invalid explicit byte length without HTTP fallback", async () => {
  await owned(async (directory) => {
    const path = join(directory, "invalid.json");
    await writeFile(path, "{}");
    let requests = 0;
    const load = createKubernetesFixtureOpenAPI({
      schemaPath: path,
      request: async () => {
        requests++;
        throw new Error("Invalid explicit input must fail closed");
      },
    });
    await expect(load()).rejects.toThrow("length mismatch");
    expect(requests).toBe(0);
  });
});

test("pinned Kubernetes fixture rejected transport load does not poison a later valid attempt", async () => {
  await owned(async (directory, bytes) => {
    let requests = 0;
    const load = createKubernetesFixtureOpenAPI({
      schemaPath: null,
      cacheDirectory: directory,
      request: async (url) => {
        expect(url).toBe(schemaUrl);
        requests++;
        if (requests === 1) throw new Error("Owned transport failure");
        return new Response(Uint8Array.from(bytes));
      },
    });
    await expect(load()).rejects.toThrow("Owned transport failure");
    expect(await readdir(directory)).toEqual([]);
    expect(requests).toBe(1);
    expect(await load()).toEqual(await kubernetesFixtureOpenAPI());
    expect(requests).toBe(2);
    expect(await readdir(directory)).toEqual(["swagger.json"]);
  });
});

test("pinned Kubernetes fixture rejects oversized or bad fetched bytes before cache publication", async () => {
  await owned(async (directory, bytes) => {
    const corrupt = Uint8Array.from(bytes);
    corrupt[0] ^= 1;
    for (const [name, invalid, reason] of [
      ["oversized", Buffer.concat([bytes, Buffer.from([0])]), "length mismatch"],
      ["corrupt", corrupt, "checksum mismatch"],
    ] as const) {
      const cacheDirectory = join(directory, name);
      await mkdir(cacheDirectory);
      const load = createKubernetesFixtureOpenAPI({
        schemaPath: null,
        cacheDirectory,
        request: async () => new Response(invalid),
      });
      await expect(load()).rejects.toThrow(reason);
      expect(await readdir(cacheDirectory)).toEqual([]);
    }
  });
});
