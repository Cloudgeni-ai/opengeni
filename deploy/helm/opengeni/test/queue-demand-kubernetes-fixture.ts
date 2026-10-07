import { createHash } from "node:crypto";

// GET-only Kubernetes fixture. All built-in model definitions are the unchanged
// upstream v1.34.0 schemas, not empty/permissive substitutes for Helm validation.
const schemaUrl =
  "https://raw.githubusercontent.com/kubernetes/kubernetes/v1.34.0/api/openapi-spec/swagger.json";
const schemaSha256 = "d3b0cdc2fda15c753206d25ab459dc7c12df64e2fd652b6809687471ea751c37";

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

let openapi: Promise<Buffer> | undefined;
export function kubernetesFixtureOpenAPI(): Promise<Buffer> {
  return (openapi ??= (async () => {
    const response = await fetch(schemaUrl, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Pinned Kubernetes fixture HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== schemaSha256)
      throw new Error("Pinned Kubernetes fixture schema checksum mismatch");
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
  })());
}

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
