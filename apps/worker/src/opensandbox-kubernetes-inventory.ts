import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";

const KUBERNETES_API_URL = "https://kubernetes.default.svc";
const KUBERNETES_TOKEN_FILE = "/var/run/secrets/opengeni.io/opensandbox-kubernetes-inventory/token";
const KUBERNETES_CA_FILE = "/var/run/secrets/opengeni.io/opensandbox-kubernetes-inventory/ca.crt";
const KUBERNETES_REQUEST_TIMEOUT_MS = 10_000;
const KUBERNETES_RESPONSE_MAX_BYTES = 64 * 1024 * 1024;
const KUBERNETES_LIST_PAGE_SIZE = 200;
const KUBERNETES_LIST_MAX_PAGES = 10_000;

export const OPENSANDBOX_CLEANUP_STUCK_SECONDS = 300;
export const OPENSANDBOX_EXPIRATION_OVERDUE_SECONDS = 180;

export const OPENSANDBOX_BATCHSANDBOX_PHASES = [
  "pending",
  "running",
  "pausing",
  "paused",
  "resuming",
  "failed",
  "unknown",
] as const;

export type OpenSandboxBatchSandboxPhase = (typeof OPENSANDBOX_BATCHSANDBOX_PHASES)[number];

export const OPENSANDBOX_WORKLOAD_POD_CONDITIONS = [
  "pending",
  "image_pull",
  "unschedulable",
] as const;

export type OpenSandboxWorkloadPodCondition = (typeof OPENSANDBOX_WORKLOAD_POD_CONDITIONS)[number];

export type OpenSandboxKubernetesInventory = {
  batchSandboxPhases: Record<OpenSandboxBatchSandboxPhase, number>;
  workloadPodConditions: Record<OpenSandboxWorkloadPodCondition, number>;
  cleanupStuck: number;
  expirationOverdue: number;
};

export type KubernetesJsonRequest = (url: URL) => Promise<unknown>;

type JsonRecord = Record<string, unknown>;

const IMAGE_PULL_REASONS = new Set(["ErrImagePull", "ImagePullBackOff", "InvalidImageName"]);

export async function inspectOpenSandboxKubernetesInventory(input: {
  namespace: string;
  nowMs?: number;
  requestJson?: KubernetesJsonRequest;
  apiUrl?: string;
  tokenFile?: string;
  caFile?: string;
}): Promise<OpenSandboxKubernetesInventory> {
  const namespace = kubernetesNamespace(input.namespace);
  const nowMs = input.nowMs ?? Date.now();
  const requestJson =
    input.requestJson ??
    (await authenticatedKubernetesJsonRequest({
      tokenFile: input.tokenFile ?? KUBERNETES_TOKEN_FILE,
      caFile: input.caFile ?? KUBERNETES_CA_FILE,
    }));
  const apiUrl = new URL(input.apiUrl ?? KUBERNETES_API_URL);
  if (apiUrl.protocol !== "https:") {
    throw new Error("OpenSandbox Kubernetes inventory API must use HTTPS");
  }

  const inventory: OpenSandboxKubernetesInventory = {
    batchSandboxPhases: zeroRecord(OPENSANDBOX_BATCHSANDBOX_PHASES),
    workloadPodConditions: zeroRecord(OPENSANDBOX_WORKLOAD_POD_CONDITIONS),
    cleanupStuck: 0,
    expirationOverdue: 0,
  };

  await visitKubernetesList({
    apiUrl,
    requestJson,
    path: `/apis/sandbox.opensandbox.io/v1alpha1/namespaces/${encodeURIComponent(namespace)}/batchsandboxes`,
    visit: (item) => observeBatchSandbox(inventory, item, nowMs),
  });
  await visitKubernetesList({
    apiUrl,
    requestJson,
    path: `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods`,
    query: { labelSelector: "opensandbox.io/id" },
    visit: (item) => observeWorkloadPod(inventory, item),
  });

  return inventory;
}

function observeBatchSandbox(
  inventory: OpenSandboxKubernetesInventory,
  item: unknown,
  nowMs: number,
): void {
  const resource = record(item);
  const metadata = record(resource.metadata);
  const spec = record(resource.spec);
  const status = record(resource.status);

  inventory.batchSandboxPhases[batchSandboxPhase(status.phase)] += 1;

  const deletionTimestampMs = dateMilliseconds(metadata.deletionTimestamp);
  const finalizers = Array.isArray(metadata.finalizers) ? metadata.finalizers : [];
  if (
    deletionTimestampMs !== null &&
    finalizers.length > 0 &&
    nowMs - deletionTimestampMs >= OPENSANDBOX_CLEANUP_STUCK_SECONDS * 1_000
  ) {
    inventory.cleanupStuck += 1;
  }

  const expirationMs = dateMilliseconds(spec.expireTime);
  if (
    expirationMs !== null &&
    nowMs - expirationMs >= OPENSANDBOX_EXPIRATION_OVERDUE_SECONDS * 1_000
  ) {
    inventory.expirationOverdue += 1;
  }
}

function observeWorkloadPod(inventory: OpenSandboxKubernetesInventory, item: unknown): void {
  const pod = record(item);
  const metadata = record(pod.metadata);
  if (dateMilliseconds(metadata.deletionTimestamp) !== null) return;

  const status = record(pod.status);
  if (status.phase === "Pending") inventory.workloadPodConditions.pending += 1;
  if (podHasImagePullFailure(status)) inventory.workloadPodConditions.image_pull += 1;
  if (podIsUnschedulable(status)) inventory.workloadPodConditions.unschedulable += 1;
}

function podHasImagePullFailure(status: JsonRecord): boolean {
  for (const key of ["initContainerStatuses", "containerStatuses", "ephemeralContainerStatuses"]) {
    const statuses = Array.isArray(status[key]) ? status[key] : [];
    for (const value of statuses) {
      const waiting = record(record(record(value).state).waiting);
      if (typeof waiting.reason === "string" && IMAGE_PULL_REASONS.has(waiting.reason)) return true;
    }
  }
  return false;
}

function podIsUnschedulable(status: JsonRecord): boolean {
  const conditions = Array.isArray(status.conditions) ? status.conditions : [];
  return conditions.some((value) => {
    const condition = record(value);
    return (
      condition.type === "PodScheduled" &&
      condition.status === "False" &&
      condition.reason === "Unschedulable"
    );
  });
}

function batchSandboxPhase(value: unknown): OpenSandboxBatchSandboxPhase {
  switch (value) {
    case "Pending":
      return "pending";
    case "Succeed":
    case "Running":
      return "running";
    case "Pausing":
      return "pausing";
    case "Paused":
      return "paused";
    case "Resuming":
      return "resuming";
    case "Failed":
      return "failed";
    default:
      return "unknown";
  }
}

async function visitKubernetesList(input: {
  apiUrl: URL;
  requestJson: KubernetesJsonRequest;
  path: string;
  query?: Record<string, string>;
  visit: (item: unknown) => void;
}): Promise<void> {
  let continuation = "";
  for (let page = 0; page < KUBERNETES_LIST_MAX_PAGES; page += 1) {
    const url = new URL(input.path, input.apiUrl);
    url.searchParams.set("limit", String(KUBERNETES_LIST_PAGE_SIZE));
    for (const [key, value] of Object.entries(input.query ?? {})) {
      url.searchParams.set(key, value);
    }
    if (continuation) url.searchParams.set("continue", continuation);

    const payload = record(await input.requestJson(url));
    if (!Array.isArray(payload.items)) {
      throw new Error(`Kubernetes list ${input.path} returned no items array`);
    }
    for (const item of payload.items) input.visit(item);

    const next = record(payload.metadata).continue;
    if (typeof next !== "string" || next.length === 0) return;
    if (next === continuation) {
      throw new Error(`Kubernetes list ${input.path} repeated its continuation token`);
    }
    continuation = next;
  }
  throw new Error(`Kubernetes list ${input.path} exceeded its page safety bound`);
}

async function authenticatedKubernetesJsonRequest(input: {
  tokenFile: string;
  caFile: string;
}): Promise<KubernetesJsonRequest> {
  const [tokenText, ca] = await Promise.all([
    readFile(input.tokenFile, "utf8"),
    readFile(input.caFile),
  ]);
  const token = tokenText.trim();
  if (!token) throw new Error("OpenSandbox Kubernetes inventory token is empty");

  return async (url) =>
    await new Promise<unknown>((resolve, reject) => {
      const request = httpsRequest(
        url,
        {
          method: "GET",
          ca,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${token}`,
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer | string) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += buffer.length;
            if (bytes > KUBERNETES_RESPONSE_MAX_BYTES) {
              request.destroy(new Error("Kubernetes inventory response exceeded its byte limit"));
              return;
            }
            chunks.push(buffer);
          });
          response.on("end", () => {
            const statusCode = response.statusCode ?? 0;
            if (statusCode < 200 || statusCode >= 300) {
              reject(new Error(`Kubernetes inventory request failed with HTTP ${statusCode}`));
              return;
            }
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch {
              reject(new Error("Kubernetes inventory response was not valid JSON"));
            }
          });
          response.on("error", reject);
        },
      );
      request.setTimeout(KUBERNETES_REQUEST_TIMEOUT_MS, () => {
        request.destroy(new Error("Kubernetes inventory request timed out"));
      });
      request.on("error", reject);
      request.end();
    });
}

function kubernetesNamespace(value: string): string {
  const namespace = value.trim();
  if (
    namespace.length === 0 ||
    namespace.length > 63 ||
    !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/u.test(namespace)
  ) {
    throw new Error("OpenSandbox Kubernetes inventory namespace is invalid");
  }
  return namespace;
}

function dateMilliseconds(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function zeroRecord<const T extends readonly string[]>(keys: T): Record<T[number], number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T[number], number>;
}
