import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type {
  SiteDataDescribeResponse,
  SiteDataQueryRequest,
  SiteDataRecordResponse,
  SiteDataWriteRequest,
  SiteSqlDescribeResponse,
} from "@opengeni/sdk";

mock.module("@/context", () => ({ useAppContext: () => ({}) }));
let module: typeof import("./site-data");
let ownsDom = false;
let previousActEnvironment: PropertyDescriptor | undefined;
beforeAll(async () => {
  ownsDom = !GlobalRegistrator.isRegistered;
  if (ownsDom) GlobalRegistrator.register({ url: "https://example.test" });
  previousActEnvironment = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  module = await import("./site-data");
});
afterAll(async () => {
  if (ownsDom) await GlobalRegistrator.unregister();
  if (previousActEnvironment)
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
  else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

const now = "2026-10-13T12:00:00.000Z";
const described: SiteDataDescribeResponse = {
  siteId: "site",
  collections: [
    {
      id: "c1",
      name: "contacts",
      accessMode: "shared",
      privateRecords: false,
      guestAccess: "none",
      jsonSchema: null,
      indexedFields: [],
      uniqueFields: [["email"]],
      recordCount: 2,
      recordBytes: 2048,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "c2",
      name: "diary",
      accessMode: "per_viewer",
      privateRecords: true,
      guestAccess: "none",
      jsonSchema: null,
      indexedFields: [],
      uniqueFields: [],
      recordCount: 0,
      recordBytes: 0,
      createdAt: now,
      updatedAt: now,
    },
  ],
  usage: {
    collectionCount: 2,
    recordCount: 2,
    recordBytes: 2048,
    fileCount: 0,
    fileBytes: 0,
    workspaceBytes: 2048,
  },
  limits: {
    recordBytesPerSite: 100 * 1024 * 1024,
    maxRecordBytes: 256 * 1024,
    maxCollectionsPerSite: 50,
    fileBytesPerSite: 1024 * 1024 * 1024,
    maxFileBytes: 10 * 1024 * 1024,
    workspaceBytes: 1024 * 1024 * 1024,
  },
};
const record = (id: string, data: Record<string, unknown>, key: string | null = null) =>
  ({
    id,
    key,
    data,
    owner: "user:me",
    createdBy: "user:me",
    updatedBy: "user:me",
    version: 3,
    sizeBytes: 120,
    createdAt: now,
    updatedAt: now,
  }) satisfies SiteDataRecordResponse;

test("names access modes and records in product words", () => {
  expect(module.siteDataAccessLabel({ accessMode: "shared_read", privateRecords: false })).toBe(
    "Everyone can view",
  );
  expect(module.siteDataAccessLabel({ accessMode: "per_viewer", privateRecords: true })).toContain(
    "hidden from managers",
  );
  expect(module.siteDataRecordTitle({ key: "acme", data: { name: "Acme" } })).toBe("acme");
  expect(module.siteDataRecordTitle({ key: null, data: { n: 1, name: " Ada " } })).toBe("Ada");
  expect(module.siteDataRecordTitle({ key: null, data: { n: 1 } })).toBe("Untitled record");
});

test("managers browse collections and records, read stored data as text and delete safely", async () => {
  const queries: SiteDataQueryRequest[] = [];
  const writes: SiteDataWriteRequest[] = [];
  const client = {
    getSiteData: async () => described,
    querySiteData: async (_ws: string, _site: string, query: SiteDataQueryRequest) => {
      queries.push(query);
      return {
        records: [
          record("r1", { name: '<img src=x onerror="alert(1)">', email: "a@example.test" }),
          record("r2", { name: "Grace" }, "grace"),
        ],
        nextCursor: null,
        count: 2,
      };
    },
    writeSiteData: async (_ws: string, _site: string, request: SiteDataWriteRequest) => {
      writes.push(request);
      return { results: [{ op: "delete" as const, deleted: { id: "r1" } }] };
    },
    exportSiteData: async () => ({
      content: "[]",
      contentType: "application/json",
      truncated: false,
    }),
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const flush = async () => {
    for (let index = 0; index < 5; index += 1) await act(async () => await Promise.resolve());
  };
  await act(async () =>
    root.render(
      <module.SiteDataPanel
        client={client as never}
        workspaceId="ws"
        siteId="site"
        title="Team CRM"
        currentPrincipal="user:me"
      />,
    ),
  );
  await flush();
  expect(host.textContent).toContain("contacts");
  expect(host.textContent).toContain("Everyone can edit");
  expect(host.textContent).toContain("2.0 KB of 100 MB");

  const openContacts = [...host.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("contacts"),
  );
  await act(async () => openContacts!.click());
  await flush();
  expect(queries[0]).toMatchObject({ collection: "contacts", count: true, limit: 50 });
  expect(host.textContent).toContain("grace");
  // Stored data is text: the markup never becomes an element.
  expect(host.querySelector("img")).toBeNull();

  const openRecord = [...host.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("<img"),
  );
  await act(async () => openRecord!.click());
  await flush();
  const json = host.querySelector('pre[aria-label="Record contents"]');
  expect(json?.textContent).toContain('"email": "a@example.test"');
  expect(host.querySelector("img")).toBeNull();
  expect(host.textContent).toContain("Added by you");

  const remove = [...host.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Delete",
  );
  await act(async () => remove!.click());
  await flush();
  const confirm = [...document.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Delete record",
  );
  expect(confirm).toBeDefined();
  await act(async () => confirm!.click());
  await flush();
  expect(writes).toEqual([
    { operations: [{ op: "delete", collection: "contacts", id: "r1", expectedVersion: 3 }] },
  ]);
  await act(async () => root.unmount());
  host.remove();
});

const sqlDescribed = (enabled: boolean, available = true): SiteSqlDescribeResponse => ({
  siteId: "site",
  available,
  enabled,
  migrations: [],
  queries: [],
  usage: { storageBytes: enabled ? 8192 : 0, rowsReadThisMonth: 0, rowsWrittenThisMonth: 0 },
  limits: {
    storageBytesPerSite: 50 * 1024 * 1024,
    rowsReadPerSitePerMonth: 5_000_000,
    rowsWrittenPerSitePerMonth: 100_000,
    callsPerMinutePerViewer: 60,
    callsPerMinutePerSite: 600,
    maxRowsPerCall: 1000,
    maxResponseBytes: 1024 * 1024,
  },
});

test("summarizes the SQL database in one line", () => {
  expect(module.siteSqlSummary(sqlDescribed(true))).toBe("8.0 KB of 50 MB · 0 queries");
  expect(module.siteSqlSummary(sqlDescribed(false))).toContain("Ask Opengeni");
  expect(
    module.siteSqlSummary({ ...sqlDescribed(false), usage: { ...sqlDescribed(true).usage } }),
  ).toBe("Off. Its data is kept.");
});

test("owners turn the SQL database on where the deployment offers it", async () => {
  for (const available of [false, true]) {
    const updates: boolean[] = [];
    const client = {
      getSiteData: async () => described,
      querySiteData: async () => ({ records: [], nextCursor: null }),
      writeSiteData: async () => ({ results: [] }),
      exportSiteData: async () => ({ content: "", contentType: "", truncated: false }),
      getSiteSql: async () => sqlDescribed(false, available),
      updateSiteSqlSettings: async (_ws: string, _site: string, request: { enabled: boolean }) => {
        updates.push(request.enabled);
        return sqlDescribed(request.enabled, available);
      },
    };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <module.SiteDataPanel
          client={client as never}
          workspaceId="ws"
          siteId="site"
          title="Polls"
          currentPrincipal="user:me"
        />,
      ),
    );
    for (let index = 0; index < 5; index += 1) await act(async () => await Promise.resolve());
    const toggle = host.querySelector<HTMLButtonElement>('button[role="switch"]');
    if (!available) {
      expect(toggle).toBeNull();
      expect(host.textContent).not.toContain("SQL database");
    } else {
      expect(host.textContent).toContain("SQL database");
      expect(toggle?.getAttribute("aria-checked")).toBe("false");
      await act(async () => toggle!.click());
      for (let index = 0; index < 5; index += 1) await act(async () => await Promise.resolve());
      expect(updates).toEqual([true]);
      expect(host.textContent).toContain("8.0 KB of 50 MB");
      expect(host.querySelector('button[role="switch"]')?.getAttribute("aria-checked")).toBe(
        "true",
      );
    }
    await act(async () => root.unmount());
    host.remove();
  }
});
