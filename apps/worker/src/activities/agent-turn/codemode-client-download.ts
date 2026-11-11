import {
  loadManagedCodemodeClient,
  loadManagedShellTools,
  managedShellToolsBackend,
  MANAGED_SHELL_TOOLS_ARCHES,
  type ManagedShellToolsDownload,
  managedCodemodeClientBytes,
  managedCodemodeClientDigest,
  type ManagedCodemodeClientDownload,
} from "@opengeni/runtime";
import type { Settings } from "@opengeni/config";
import type { ObjectStorage } from "@opengeni/storage";
import { gzipSync } from "node:zlib";
import { objectStorageForSandboxDownloads } from "./file-resources";

// A box can sit behind a slow provider queue; the URL only has to outlive the
// setup command that fetches it.
const DOWNLOAD_URL_TTL_SECONDS = 15 * 60;
// Re-check storage now and then so a lifecycle-expired object is republished.
const PUBLISHED_RECHECK_MS = 60 * 60 * 1000;

const published = new Map<string, { at: number; done: Promise<void> }>();

export function managedCodemodeClientObjectKey(digest: string): string {
  return `sandbox-assets/codemode-client/${digest}.json.gz`;
}

/** Bundles are already gzip-compressed tars, stored as they are. */
export function managedShellToolsObjectKey(sha256: string): string {
  return `sandbox-assets/shell-tools/${sha256}.tar.gz`;
}

async function publishOnce(objectStorage: ObjectStorage, key: string, body: Uint8Array) {
  const head = objectStorage.headObject ? await objectStorage.headObject(key) : null;
  if (head) return;
  await objectStorage.putObject({ key, contentType: "application/gzip", body });
}

function publishMemoized(objectStorage: ObjectStorage, key: string, body: () => Uint8Array) {
  const memoKey = `${objectStorage.bucket}\0${key}`;
  let entry = published.get(memoKey);
  if (!entry || Date.now() - entry.at > PUBLISHED_RECHECK_MS) {
    const done = publishOnce(objectStorage, key, body());
    entry = { at: Date.now(), done };
    published.set(memoKey, entry);
    done.catch(() => {
      if (published.get(memoKey) === entry) published.delete(memoKey);
    });
  }
  return entry.done;
}

/**
 * Signed URLs for the release's rg and jq bundles, for backends whose boxes
 * the worker sets up itself. Any failure only leaves them to be staged.
 */
async function managedShellToolsDownload(
  settings: Settings,
  objectStorage: ObjectStorage,
  activeSandboxBackend: Settings["sandboxBackend"],
): Promise<ManagedShellToolsDownload | undefined> {
  if (!managedShellToolsBackend(activeSandboxBackend)) return undefined;
  try {
    const tools = await loadManagedShellTools();
    if (!tools) return undefined;
    const storage = objectStorageForSandboxDownloads(settings, objectStorage, activeSandboxBackend);
    const urls: ManagedShellToolsDownload = {};
    for (const arch of MANAGED_SHELL_TOOLS_ARCHES) {
      const key = managedShellToolsObjectKey(tools[arch].sha256);
      await publishMemoized(objectStorage, key, () => tools[arch].bytes);
      urls[arch] = (
        await storage.createGetUrl({ key, expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS })
      ).url;
    }
    return urls;
  } catch (error) {
    console.warn("Managed shell tools download unavailable; boxes will stage them instead", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return undefined;
  }
}

/**
 * Publishes a compressed transfer of this release's managed Codemode client under its digest and signs
 * a short-lived download URL for a managed box. Returns undefined on any
 * failure: the runtime then stages the bytes through the provider file API.
 */
export async function managedCodemodeClientDownload(input: {
  settings: Settings;
  objectStorage: ObjectStorage | null | undefined;
  activeSandboxBackend: Settings["sandboxBackend"] | undefined;
}): Promise<ManagedCodemodeClientDownload | undefined> {
  const { objectStorage, activeSandboxBackend } = input;
  // Connected Machines receive the client through their own delivery path.
  if (!objectStorage || !activeSandboxBackend || activeSandboxBackend === "selfhosted") {
    return undefined;
  }
  try {
    const client = await loadManagedCodemodeClient();
    const digest = managedCodemodeClientDigest(client);
    const key = managedCodemodeClientObjectKey(digest);
    await publishMemoized(objectStorage, key, () =>
      gzipSync(new TextEncoder().encode(managedCodemodeClientBytes(client))),
    );
    const signed = await objectStorageForSandboxDownloads(
      input.settings,
      objectStorage,
      activeSandboxBackend,
    ).createGetUrl({ key, expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS });
    const shellTools = await managedShellToolsDownload(
      input.settings,
      objectStorage,
      activeSandboxBackend,
    );
    return { url: signed.url, ...(shellTools ? { shellTools } : {}) };
  } catch (error) {
    console.warn("Managed Codemode client download unavailable; boxes will stage it instead", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return undefined;
  }
}

export function resetManagedCodemodeClientPublicationForTest(): void {
  published.clear();
}
