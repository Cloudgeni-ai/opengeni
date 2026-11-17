import { expect, test } from "bun:test";
import { createOpenGeniText } from "@opengeni/react/messages";
import type { AccessContext, ArtifactCatalogItem } from "@opengeni/sdk";
import {
  ARTIFACT_KIND_FILTERS,
  artifactMenu,
  artifactWebUrl,
  deleteConfirmation,
  downloadFormat,
  editedLabel,
  emptyListWords,
  nativeViewPath,
  siteStillDocument,
  viewerKeepsNavigation,
  viewerMode,
  viewerParamsForLink,
  viewerPath,
} from "./artifacts";

const t = createOpenGeniText();
const access = (permissions: string[]) =>
  ({
    workspaceGrants: [{ workspaceId: "work", permissions }],
  }) as unknown as AccessContext;

function item(overrides: Partial<ArtifactCatalogItem> = {}): ArtifactCatalogItem {
  return {
    id: "a1",
    kind: "presentation",
    title: "Demo-presentasjon",
    createdAt: "2026-11-01T08:00:00.000Z",
    updatedAt: "2026-11-17T06:00:00.000Z",
    status: "active",
    pinned: false,
    sourceSessionId: "s1",
    ...overrides,
  };
}

const ids = (menu: { id: string }[]) => menu.map((entry) => entry.id);

test("the type chips match the web library", () => {
  expect(ARTIFACT_KIND_FILTERS.map((each) => each.label)).toEqual([
    "All",
    "Sites",
    "Documents",
    "Presentations",
    "Spreadsheets",
    "Images",
  ]);
});

test("a presentation's menu: Open chat, Pin, Copy link, then Delete… for a publisher", () => {
  const menu = artifactMenu(item(), {
    accessContext: access(["artifacts:read", "artifacts:publish"]),
    workspaceId: "work",
    pinKnown: true,
  });
  expect(ids(menu)).toEqual(["open-chat", "pin", "copy-link", "delete"]);
  expect(menu.at(-1)).toMatchObject({ title: "Delete…", destructive: true, section: "danger" });
});

test("a reader gets no Delete, and no Open chat back into the chat it came from", () => {
  const menu = artifactMenu(item({ pinned: true }), {
    accessContext: access(["artifacts:read"]),
    workspaceId: "work",
    fromSessionId: "s1",
    pinKnown: true,
  });
  expect(ids(menu)).toEqual(["unpin", "copy-link"]);
});

test("a Site can be duplicated and downloaded; Sites, images and files have no Delete", () => {
  const publisher = {
    accessContext: access(["artifacts:read", "artifacts:publish"]),
    workspaceId: "work",
    pinKnown: true,
  };
  expect(ids(artifactMenu(item({ kind: "site", versionId: "v1" }), publisher))).toEqual([
    "open-chat",
    "pin",
    "duplicate",
    "copy-link",
    "download",
  ]);
  expect(ids(artifactMenu(item({ kind: "image" }), publisher))).not.toContain("delete");
  // Pin state unknown (opened from a link the list never held): no Pin.
  expect(ids(artifactMenu(item({ kind: "file" }), { ...publisher, pinKnown: false }))).toEqual([
    "open-chat",
    "copy-link",
    "download",
  ]);
});

test("an archived artifact can't be pinned, duplicated or deleted again", () => {
  const menu = artifactMenu(item({ status: "archived" }), {
    accessContext: access(["workspace:admin"]),
    workspaceId: "work",
    pinKnown: true,
  });
  expect(ids(menu)).toEqual(["open-chat", "copy-link"]);
});

test("download is in the original format where there is one", () => {
  expect(downloadFormat({ kind: "site", versionId: "v1" })).toBe("html");
  expect(downloadFormat({ kind: "site" })).toBeNull();
  expect(downloadFormat({ kind: "image" })).toBe("original");
  expect(downloadFormat({ kind: "file" })).toBe("original");
  expect(downloadFormat({ kind: "spreadsheet" })).toBe("xlsx");
  expect(downloadFormat({ kind: "document" })).toBeNull();
  expect(downloadFormat({ kind: "presentation" })).toBeNull();
});

test("Delete asks with the web library's words", () => {
  expect(deleteConfirmation({ kind: "document", title: "Sales reporting" })).toEqual({
    title: "Delete Sales reporting?",
    message: "It's removed from Artifacts and can't be opened again.",
    confirm: "Delete document",
  });
});

test("each card says when it was last edited", () => {
  const now = new Date("2026-11-17T08:00:00.000Z");
  expect(editedLabel(t, "2026-11-17T07:59:50.000Z", now)).toBe("Edited just now");
  expect(editedLabel(t, "2026-11-17T06:00:00.000Z", now)).toBe("Edited 2h ago");
  expect(editedLabel(t, "2026-11-03T06:00:00.000Z", now)).toMatch(/^Edited Nov 3/u);
});

test("the empty list speaks to the filter and search", () => {
  expect(emptyListWords("all", "").title).toBe("No artifacts yet");
  expect(emptyListWords("presentation", "").title).toBe("No presentations yet");
  expect(emptyListWords("site", " metronor ").title).toBe("No sites match “metronor”");
});

test("chat links open the viewer; chats and sandbox files don't", () => {
  expect(
    viewerParamsForLink({ kind: "editable-artifact", artifactId: "e1", workspaceId: null }, "work"),
  ).toEqual({ id: "e1", kind: "document", workspaceId: "work" });
  expect(
    viewerParamsForLink({ kind: "site", artifactId: "s1", workspaceId: "other" }, "work"),
  ).toEqual({ id: "s1", kind: "site", workspaceId: "other" });
  expect(viewerParamsForLink({ kind: "file", fileId: "f1", workspaceId: null }, "work")).toEqual({
    id: "f1",
    kind: "file",
    workspaceId: "work",
  });
  expect(viewerParamsForLink({ kind: "session", sessionId: "x", workspaceId: null }, "w")).toBe(
    null,
  );
  expect(viewerParamsForLink({ kind: "sandbox-file", path: "/a", line: null }, "w")).toBeNull();
});

test("viewer addresses carry the kind, workspace, title and source chat", () => {
  expect(
    viewerPath({ id: "a 1", kind: "site", workspaceId: "work", title: "Sales", from: "s1" }),
  ).toBe("/artifact/a%201?kind=site&workspaceId=work&title=Sales&from=s1");
});

test("Sites and editors show in the web app's chromeless pages; images and files natively", () => {
  expect(nativeViewPath("work", { kind: "site", id: "s1" })).toBe(
    "/native-view/workspaces/work/sites/s1",
  );
  expect(nativeViewPath("work", { kind: "spreadsheet", id: "e1" })).toBe(
    "/native-view/workspaces/work/artifacts/editable/e1",
  );
  expect(nativeViewPath("work", { kind: "image", id: "i1" })).toBeNull();
  expect(viewerMode("presentation")).toBe("editable");
  expect(viewerMode("image")).toBe("image");
});

test("the viewer's page stays on the deployment; other addresses open outside", () => {
  const base = "https://app.opengeni.ai";
  expect(viewerKeepsNavigation(base, { url: `${base}/native-view/x`, isTopFrame: true })).toBe(
    true,
  );
  expect(viewerKeepsNavigation(base, { url: "https://example.com", isTopFrame: true })).toBe(false);
  // A Site's own frame loads from its own origin.
  expect(viewerKeepsNavigation(base, { url: "https://site.example", isTopFrame: false })).toBe(
    true,
  );
});

test("Share and Copy link use the web address", () => {
  expect(artifactWebUrl("https://app.opengeni.ai/", "work", { kind: "site", id: "s1" })).toMatch(
    /^https:\/\/app\.opengeni\.ai\/workspaces\/work\/artifacts\/s1/u,
  );
});

test("a Site's still runs no scripts", () => {
  const still = siteStillDocument("<h1>Metronor demo overview</h1>");
  expect(still).toContain("Content-Security-Policy");
  expect(still).toContain("<h1>Metronor demo overview</h1>");
});
