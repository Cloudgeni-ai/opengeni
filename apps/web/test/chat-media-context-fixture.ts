import type { RetainedArtifactReference } from "@opengeni/sdk";

export const workspaceId = "11111111-1111-4111-8111-111111111111";
export const siteId = "22222222-2222-4222-8222-222222222222";
export const imageId = "33333333-3333-4333-8333-333333333333";
const versionId = "44444444-4444-4444-8444-444444444444";
let released = false;
const pending: (() => void)[] = [];
const delayed = () =>
  released ? Promise.resolve() : new Promise<void>((resolve) => pending.push(resolve));
export const mediaFixture = {
  siteReads: 0,
  imageReads: 0,
  byteReads: 0,
  release() {
    released = true;
    for (const resolve of pending.splice(0)) resolve();
  },
};

const artifact: RetainedArtifactReference = {
  available: true,
  artifactId: imageId,
  kind: "file",
  contentType: "image/svg+xml",
  originalBytes: 100,
  sha256: "a".repeat(64),
  retainedAt: "2026-09-14T00:00:00Z",
  dimensions: { width: 1200, height: 800 },
  retention: { policy: "workspace_file", expiresAt: null },
  retrieval: {
    method: "GET",
    path: "/fixture/image",
    acceptRanges: "bytes",
    maxRangeBytes: 1048576,
  },
};
const client = {
  tools: { forWorkspace: () => ({}) },
  async getWorkspaceArtifact() {
    mediaFixture.siteReads++;
    await delayed();
    const version = { id: versionId, revision: 1, requestedTools: [] };
    return {
      artifact: {
        id: siteId,
        workspaceId,
        title: "Delayed Site",
        status: "active",
        currentVersion: version,
      },
      versions: [version],
    };
  },
  async getWorkspaceArtifactHtml() {
    return "<h1>Loaded Site</h1><button onclick=\"this.textContent='State retained'\">Change state</button>";
  },
  async getRetainedArtifact() {
    mediaFixture.imageReads++;
    await delayed();
    return artifact;
  },
  async downloadRetainedArtifact() {
    mediaFixture.byteReads++;
    return {
      artifact,
      bytes: new TextEncoder().encode(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="#0f766e"/><text x="80" y="180" font-size="72" fill="white">Delayed image</text></svg>',
      ),
    };
  },
};
export const useAppContext = () => ({ client, accessKeyVersion: 0 });
export const useAppearance = () => ({ resolvedTheme: "light" as const });
