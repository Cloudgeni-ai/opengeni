import { describe, expect, test } from "bun:test";
import { artifactReturnSearch } from "./routes";
import { sessionArtifactFromHref } from "./session-artifact-navigation";
import { isEditableArtifactKind } from "./artifact-catalog";
import { parseSync } from "oxc-parser";

const workspace = "11111111-1111-4111-8111-111111111111";
const artifact = "22222222-2222-4222-8222-222222222222";
const origin = "https://console.example";
const path = `/workspaces/${workspace}/artifacts/${artifact}`;

describe("session artifact navigation", () => {
  test("recognizes canonical relative and absolute Site and editor links", () => {
    for (const href of [path, `${origin}${path}`]) {
      expect(sessionArtifactFromHref(href, origin, workspace)).toEqual({
        id: artifact,
        editable: false,
      });
    }
    expect(
      sessionArtifactFromHref(
        path.replace("/artifacts/", "/artifacts/editable/"),
        origin,
        workspace,
      ),
    ).toEqual({ id: artifact, editable: true });
  });
  test("leaves foreign, malformed, download, and version-specific destinations alone", () => {
    for (const href of [
      `https://other.example${path}`,
      `//other.example${path}`,
      path.replace(workspace, artifact),
      `${path}/content`,
      `${path}?version=1`,
      `${path}#section`,
      path.replace(artifact, "invalid"),
      "javascript:alert(1)",
      "/workspace/report.html",
    ])
      expect(sessionArtifactFromHref(href, origin, workspace)).toBeNull();
  });
  test("recognizes durable image and file destinations without a sandbox path", () => {
    expect(
      sessionArtifactFromHref(path.replace("/artifacts/", "/artifacts/images/"), origin, workspace),
    ).toBeNull();
    expect(
      sessionArtifactFromHref(path.replace("/artifacts/", "/artifacts/files/"), origin, workspace),
    ).toEqual({ id: artifact, editable: false, kind: "file" });
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
      expect(artifactReturnSearch({ fromSession })).toEqual({});
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
        { id: artifact, modality: "image" },
        { id: artifact, modality },
      ]);
      const target = sessionArtifactFromHref(
        path.replace("/artifacts/", "/artifacts/editable/"),
        origin,
        workspace,
      )!;
      expect(onOpen(target)).toBe(true);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.artifactKind).toBe(modality);
    });
  }
  for (const modality of ["image", "file"]) {
    test(`an undiscovered editable link is not intercepted by ${modality} metadata`, async () => {
      const { onOpen, requests } = await sessionOpenCallback([{ id: artifact, modality }]);
      const target = sessionArtifactFromHref(
        path.replace("/artifacts/", "/artifacts/editable/"),
        origin,
        workspace,
      )!;
      expect(onOpen(target)).toBe(false);
      expect(requests).toEqual([]);
    });
  }
});
