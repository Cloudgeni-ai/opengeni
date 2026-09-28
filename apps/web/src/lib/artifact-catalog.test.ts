import { afterEach, describe, expect, test } from "bun:test";
import type { ArtifactCatalogItem } from "@opengeni/sdk";
import {
  artifactKey,
  artifactPath,
  artifactRoute,
  defaultArtifactFilters,
  filterArtifactCatalog,
} from "./artifact-catalog";
import { artifactExtension, readArtifactView, rememberArtifactView } from "./artifact-library-view";

const item = (
  id: string,
  kind: ArtifactCatalogItem["kind"],
  title: string,
  status: ArtifactCatalogItem["status"] = "active",
): ArtifactCatalogItem => ({
  id,
  kind,
  title,
  status,
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-02T00:00:00Z",
});
const items = [
  item("same", "site", "Status board"),
  item("same", "image", "Project logo"),
  item("doc", "document", "Archive notes", "archived"),
];
const storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
afterEach(() => {
  if (storage) Object.defineProperty(globalThis, "localStorage", storage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});
describe("artifact catalog", () => {
  test("uses kind and native ID together and preserves domain routes", () => {
    expect(new Set(items.map(artifactKey)).size).toBe(3);
    expect(artifactRoute("site")).toBe("/workspaces/$workspaceId/artifacts/$artifactId");
    expect(artifactRoute("document")).toContain("/editable/");
    expect(artifactRoute("image")).toBe(artifactRoute("file"));
    expect(artifactRoute("file")).toContain("/files/");
  });
  test("combines title, kind, archive filters and sorts a copy", () => {
    expect(filterArtifactCatalog(items, defaultArtifactFilters).length).toBe(2);
    expect(
      filterArtifactCatalog(items, { ...defaultArtifactFilters, q: "  PROJECT ", kind: "image" }),
    ).toEqual([items[1]!]);
    expect(filterArtifactCatalog(items, { ...defaultArtifactFilters, status: "archived" })).toEqual(
      [items[2]!],
    );
    expect(
      filterArtifactCatalog(items, { ...defaultArtifactFilters, sort: "title" }).map(
        (i) => i.title,
      ),
    ).toEqual(["Project logo", "Status board"]);
    expect(items[0]!.title).toBe("Status board");
  });
  test("newest differs from recently updated", () => {
    const older = {
      ...items[0]!,
      createdAt: "2026-08-01T00:00:00Z",
      updatedAt: "2026-09-09T00:00:00Z",
    };
    expect(filterArtifactCatalog([older, items[1]!], defaultArtifactFilters)[0]).toBe(older);
    expect(
      filterArtifactCatalog([older, items[1]!], { ...defaultArtifactFilters, sort: "newest" })[0],
    ).toBe(items[1]!);
  });
  test("builds plain artifact URLs with the return-to-session search", () => {
    expect(artifactPath("ws 1", { kind: "site", id: "a/b" })).toBe(
      "/workspaces/ws%201/artifacts/a%2Fb",
    );
    expect(artifactPath("ws", { kind: "image", id: "i" }, "s1")).toBe(
      "/workspaces/ws/artifacts/files/i?fromSession=s1",
    );
  });
  test("defaults to the gallery, keeps List, and survives blocked browser storage", () => {
    const saved = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => saved.get(key) ?? null,
        setItem: (key: string, value: string) => void saved.set(key, value),
      },
    });
    expect(readArtifactView()).toBe("gallery");
    rememberArtifactView("list");
    expect(readArtifactView()).toBe("list");
    saved.set("opengeni:artifact-library:view:v1", "unsafe");
    expect(readArtifactView()).toBe("gallery");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => {
        throw new Error("blocked");
      },
    });
    expect(readArtifactView()).toBe("gallery");
    expect(() => rememberArtifactView("list")).not.toThrow();
  });
  test("reads a file's extension for its placeholder", () => {
    expect(artifactExtension({ title: "Export", filename: "Research export.CSV" })).toBe("csv");
    expect(artifactExtension({ title: "Notes" })).toBeNull();
  });
});
