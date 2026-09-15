import { describe, expect, test } from "bun:test";
import { artifactReturnSearch } from "./routes";
import { sessionArtifactFromHref } from "./session-artifact-navigation";
import { isEditableArtifactKind } from "./artifact-catalog";
import { parseSync } from "oxc-parser";

// Production seed 2026-09-15: Sites/files are UUIDs; native editors are 32-hex.
const workspace = "5d929faa-c755-4146-9d60-e55f42251f0d";
const siteId = "dc24100a-e408-4713-9c12-ef41e3964f6a";
const documentId = "d10307ab68064d36855af499c9e3ccc7";
const fileId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const uuidShaped = "22222222-2222-4222-8222-222222222222";
const origin = "https://console.example";
const sitePath = `/workspaces/${workspace}/artifacts/${siteId}`;
const documentPath = `/workspaces/${workspace}/artifacts/editable/${documentId}`;
const filePath = `/workspaces/${workspace}/artifacts/files/${fileId}`;

describe("session artifact navigation", () => {
  test("recognizes canonical relative and absolute Site and editor links", () => {
    for (const href of [sitePath, `${origin}${sitePath}`]) {
      expect(sessionArtifactFromHref(href, origin, workspace)).toEqual({
        id: siteId,
        editable: false,
      });
    }
    expect(sessionArtifactFromHref(documentPath, origin, workspace)).toEqual({
      id: documentId,
      editable: true,
    });
    expect(sessionArtifactFromHref(`${origin}${documentPath}`, origin, workspace)).toEqual({
      id: documentId,
      editable: true,
    });
  });
  test("rejects UUID-shaped editor IDs and 32-hex Site or file IDs", () => {
    expect(
      sessionArtifactFromHref(
        `/workspaces/${workspace}/artifacts/editable/${uuidShaped}`,
        origin,
        workspace,
      ),
    ).toBeNull();
    expect(
      sessionArtifactFromHref(
        `/workspaces/${workspace}/artifacts/${documentId}`,
        origin,
        workspace,
      ),
    ).toBeNull();
    expect(
      sessionArtifactFromHref(
        `/workspaces/${workspace}/artifacts/files/${documentId}`,
        origin,
        workspace,
      ),
    ).toBeNull();
  });
  test("leaves foreign, malformed, download, and version-specific destinations alone", () => {
    for (const href of [
      `https://other.example${sitePath}`,
      `//other.example${sitePath}`,
      `https://user:pass@console.example${sitePath}`,
      sitePath.replace(workspace, siteId),
      `${sitePath}/content`,
      `${sitePath}?version=1`,
      `${sitePath}#section`,
      `${documentPath}?version=1`,
      `${documentPath}#section`,
      sitePath.replace(siteId, "invalid"),
      documentPath.replace(documentId, "invalid"),
      "javascript:alert(1)",
      "/workspace/report.html",
    ])
      expect(sessionArtifactFromHref(href, origin, workspace)).toBeNull();
  });
  test("recognizes durable image and file destinations without a sandbox path", () => {
    expect(
      sessionArtifactFromHref(
        sitePath.replace("/artifacts/", "/artifacts/images/"),
        origin,
        workspace,
      ),
    ).toBeNull();
    expect(sessionArtifactFromHref(filePath, origin, workspace)).toEqual({
      id: fileId,
      editable: false,
      kind: "file",
    });
  });
  test("accepts only a session ID as return context, never an arbitrary URL", () => {
    expect(artifactReturnSearch({ fromSession: workspace })).toEqual({ fromSession: workspace });
    for (const fromSession of [
      "https://evil.example",
      "../sessions",
      "",
      12,
      [workspace],
      undefined,
    ]) {
      expect(artifactReturnSearch({ fromSession })).toEqual({ fromSession: undefined });
    }
  });
});

function* astNodes(value: unknown): Generator<Record<string, unknown>> {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const child of value) yield* astNodes(child);
    return;
  }
  const node = value as Record<string, unknown>;
  yield node;
  for (const child of Object.values(node)) yield* astNodes(child);
}

/** Exercise the exact production callback without mounting the session runtime. */
async function sessionOpenCallback(artifacts: { id: string; modality: string }[]) {
  const source = await Bun.file(new URL("../routes/session.tsx", import.meta.url)).text();
  const { program } = parseSync("session.tsx", source);
  const boundary = [...astNodes(program)].find(
    (node) =>
      node.type === "JSXOpeningElement" &&
      (node.name as { name?: string } | undefined)?.name === "ArtifactLinkBoundary",
  );
  const attribute = (boundary?.attributes as Record<string, unknown>[] | undefined)?.find(
    (node) => (node.name as { name?: string } | undefined)?.name === "onOpen",
  );
  const expression = (
    attribute?.value as { expression?: { start: number; end: number } } | undefined
  )?.expression;
  if (!expression) throw new Error("Production artifact-link callback was not found");
  const requests: { artifactKind?: string }[] = [];
  const factory = new Function(
    "artifactSummaries",
    "props",
    "setArtifactRequest",
    "isEditableArtifactKind",
    `return (${source.slice(expression.start, expression.end)});`,
  );
  const onOpen = factory(
    artifacts,
    { sessionId: "session" },
    (update: (previous: null) => { artifactKind?: string }) => requests.push(update(null)),
    isEditableArtifactKind,
  ) as (target: NonNullable<ReturnType<typeof sessionArtifactFromHref>>) => boolean;
  return { onOpen, requests };
}

describe("production session artifact-link callback", () => {
  for (const modality of ["document", "spreadsheet", "presentation"]) {
    test(`an editable link selects ${modality}, never a colliding image`, async () => {
      const { onOpen, requests } = await sessionOpenCallback([
        { id: documentId, modality: "image" },
        { id: documentId, modality },
      ]);
      const target = sessionArtifactFromHref(documentPath, origin, workspace)!;
      expect(target).toEqual({ id: documentId, editable: true });
      expect(onOpen(target)).toBe(true);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.artifactKind).toBe(modality);
    });
  }
  for (const modality of ["image", "file"]) {
    test(`an undiscovered editable link is not intercepted by ${modality} metadata`, async () => {
      const { onOpen, requests } = await sessionOpenCallback([{ id: documentId, modality }]);
      const target = sessionArtifactFromHref(documentPath, origin, workspace)!;
      expect(onOpen(target)).toBe(false);
      expect(requests).toEqual([]);
    });
  }
  test("unknown editable modality is not guessed and leaves the full-page destination", async () => {
    const { onOpen, requests } = await sessionOpenCallback([{ id: documentId, modality: "site" }]);
    const target = sessionArtifactFromHref(documentPath, origin, workspace)!;
    expect(onOpen(target)).toBe(false);
    expect(requests).toEqual([]);
  });
});
