import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// GET-only Kubernetes fixture. All built-in model definitions are the unchanged
// upstream v1.34.0 schemas, not empty/permissive substitutes for Helm validation.
const schemaUrl =
  "https://raw.githubusercontent.com/kubernetes/kubernetes/v1.34.0/api/openapi-spec/swagger.json";
const schemaSha256 = "d3b0cdc2fda15c753206d25ab459dc7c12df64e2fd652b6809687471ea751c37";
const schemaBytes = 3828201;

type FixtureSchemaInput = {
  // Explicit input is authoritative: missing/invalid bytes never fall back to HTTP.
  // null selects the cache instead of the OPENGENI_KUBERNETES_FIXTURE_SCHEMA override.
  schemaPath?: string | null;
  cacheDirectory?: string;
  request?: (url: string, options: RequestInit) => Promise<Response>;
};

function verifySchemaBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength !== schemaBytes)
    throw new Error("Pinned Kubernetes fixture schema length mismatch");
  if (createHash("sha256").update(bytes).digest("hex") !== schemaSha256)
    throw new Error("Pinned Kubernetes fixture schema checksum mismatch");
  return bytes;
}

async function readSchemaFile(path: string): Promise<Uint8Array> {
  if ((await stat(path)).size !== schemaBytes)
    throw new Error("Pinned Kubernetes fixture schema length mismatch");
  return verifySchemaBytes(await readFile(path));
}

async function fixtureSchemaBytes(input: FixtureSchemaInput): Promise<Uint8Array> {
  const explicit =
    input.schemaPath === null
      ? undefined
      : (input.schemaPath ?? process.env.OPENGENI_KUBERNETES_FIXTURE_SCHEMA);
  if (explicit !== undefined) return readSchemaFile(explicit);
  // Same temporary-root cache convention as Helm/promtool, with immutable input identity.
  const directory =
    input.cacheDirectory ?? join(tmpdir(), `opengeni-kubernetes-openapi-v1.34.0-${schemaSha256}`);
  const path = join(directory, "swagger.json");
  try {
    return await readSchemaFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const response = await (input.request ?? fetch)(schemaUrl, {
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Pinned Kubernetes fixture HTTP ${response.status}`);
  if (!response.body) throw new Error("Pinned Kubernetes fixture schema body missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > schemaBytes) throw new Error("Pinned Kubernetes fixture schema length mismatch");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = verifySchemaBytes(Buffer.concat(chunks));
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.swagger-${process.pid}-${randomUUID()}.json`);
  await writeFile(temporary, bytes, { flag: "wx" });
  try {
    // Publish only complete verified bytes; never overwrite another process's cache.
    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return await readSchemaFile(path);
  } finally {
    await unlink(temporary);
  }
}

// Protobuf field numbers follow Apache-2.0 google/gnostic-models v0.6.9,
// openapiv2/OpenAPIv2.proto. Encode every schema field present in this pinned
// document; fail closed if the input acquires an unhandled validation keyword.
function varint(value: number): Buffer {
  const bytes: number[] = [];
  do {
    bytes.push((value & 0x7f) | (value > 0x7f ? 0x80 : 0));
    value = Math.floor(value / 128);
  } while (value);
  return Buffer.from(bytes);
}
function field(number: number, value: string | Uint8Array): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
  return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
}
type Schema = Record<string, any>;
function namedSchema(name: string, value: Schema): Buffer {
  return Buffer.concat([field(1, name), field(2, schema(value))]);
}
function schema(value: Schema): Buffer {
  const fields: Buffer[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (key === "$ref") fields.push(field(1, entry));
    else if (key === "format") fields.push(field(2, entry));
    else if (key === "description") fields.push(field(4, entry));
    else if (key === "required") for (const required of entry) fields.push(field(19, required));
    else if (key === "additionalProperties") {
      fields.push(
        field(
          21,
          typeof entry === "boolean" ? Buffer.from([16, Number(entry)]) : field(1, schema(entry)),
        ),
      );
    } else if (key === "type") fields.push(field(22, field(1, entry)));
    else if (key === "items") fields.push(field(23, field(1, schema(entry))));
    else if (key === "properties")
      fields.push(
        field(
          25,
          Buffer.concat(
            Object.entries(entry).map(([name, property]) =>
              field(1, namedSchema(name, property as Schema)),
            ),
          ),
        ),
      );
    else if (key.startsWith("x-"))
      fields.push(
        field(31, Buffer.concat([field(1, key), field(2, field(2, JSON.stringify(entry)))])),
      );
    else throw new Error(`Unhandled pinned Kubernetes schema keyword: ${key}`);
  }
  return Buffer.concat(fields);
}

// Separate owned loaders let controls exercise cache/input failures without global env mutation.
export function createKubernetesFixtureOpenAPI(
  input: FixtureSchemaInput = {},
): () => Promise<Buffer> {
  let openapi: Promise<Buffer> | undefined;
  const load = async () => {
    const bytes = await fixtureSchemaBytes(input);
    const document = JSON.parse(new TextDecoder().decode(bytes));
    return Buffer.concat([
      field(1, "2.0"),
      field(2, Buffer.concat([field(1, "Owned GET-only Kubernetes fixture"), field(2, "v1.34.0")])),
      // This fixture rejects every mutation. Do not advertise server-side field
      // validation support: Helm must use the actual model schemas client-side.
      field(8, Buffer.alloc(0)),
      field(
        9,
        Buffer.concat(
          Object.entries(document.definitions).map(([name, definition]) =>
            field(1, namedSchema(name, definition as Schema)),
          ),
        ),
      ),
    ]);
  };
  return () =>
    (openapi ??= load().catch((error) => {
      // A corrected input or a later valid fetch must be usable after a failed load.
      openapi = undefined;
      throw error;
    }));
}

export const kubernetesFixtureOpenAPI = createKubernetesFixtureOpenAPI();

export const kubernetesFixtureResources: Record<string, { name: string; kind: string }[]> = {
  v1: [
    { name: "configmaps", kind: "ConfigMap" },
    { name: "services", kind: "Service" },
    { name: "serviceaccounts", kind: "ServiceAccount" },
  ],
  "apps/v1": [{ name: "deployments", kind: "Deployment" }],
  "autoscaling/v2": [{ name: "horizontalpodautoscalers", kind: "HorizontalPodAutoscaler" }],
  "batch/v1": [{ name: "jobs", kind: "Job" }],
  "networking.k8s.io/v1": [
    { name: "ingresses", kind: "Ingress" },
    { name: "networkpolicies", kind: "NetworkPolicy" },
  ],
  "policy/v1": [{ name: "poddisruptionbudgets", kind: "PodDisruptionBudget" }],
  "monitoring.coreos.com/v1": [
    { name: "prometheusrules", kind: "PrometheusRule" },
    { name: "servicemonitors", kind: "ServiceMonitor" },
  ],
};
