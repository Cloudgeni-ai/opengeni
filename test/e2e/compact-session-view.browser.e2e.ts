import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { freePort, startProcess, waitFor, type StartedProcess } from "@opengeni/testing";
import { OPENGENI_API_CONTRACT_REVISION } from "@opengeni/sdk";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const otherWorkspaceId = "11111111-1111-4111-8111-222222222222";
const accountId = "22222222-2222-4222-8222-222222222222";
const projectId = "44444444-4444-4444-8444-444444444444";
const now = new Date().toISOString();
const control = {
  state: "active",
  directState: "active",
  revision: 0,
  controlVersion: 0,
  primaryBlocker: null,
  additionalBlockerCount: 0,
  blockers: [],
  resumeOptions: [],
};
const rows = Array.from({ length: 65 }, (_, index) => ({
  id: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
  workspaceId,
  accountId,
  parentSessionId: null,
  rootSessionId: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
  title: `Session ${String(64 - index).padStart(2, "0")}`,
  titleSource: "user",
  initialMessage: "Fixture",
  status: "idle",
  createdBy: { kind: "subject", subjectId: "fixture", label: "Fixture" },
  resources: [],
  skills: [],
  tools: [],
  metadata: {},
  model: "scripted-model",
  sandboxBackend: "none",
  effectiveControl: control,
  channelId: null,
  pinned: false,
  archived: index === 64,
  archivedAt: index === 64 ? now : null,
  pinVersion: 0,
  archiveVersion: 0,
  lastSequence: 0,
  createdAt: new Date(Date.now() - (64 - index) * 60_000).toISOString(),
  updatedAt: new Date(Date.now() - index * 60_000).toISOString(),
}));

type FixtureRow = Omit<(typeof rows)[number], "parentSessionId"> & {
  parentSessionId: string | null;
};
const pendingFixtureGateReleases = new Set<() => void>();
const releaseFixtureGates = () => {
  for (const resolve of pendingFixtureGateReleases) resolve();
};
const deferred = () => {
  let complete!: () => void;
  const promise = new Promise<void>((done) => {
    complete = done;
  });
  const resolve = () => {
    pendingFixtureGateReleases.delete(resolve);
    complete();
  };
  pendingFixtureGateReleases.add(resolve);
  return { promise, resolve };
};

describe("compact session view on the live local workspace route (API fixture)", () => {
  let web: StartedProcess;
  let browser: Browser;
  let page: Page;
  let baseUrl: string;
  const listRequests: URL[] = [];
  let archiveFixture:
    | {
        root: FixtureRow;
        children: FixtureRow[];
        peers: FixtureRow[];
        mutation?: ReturnType<typeof deferred>;
        mutationStarted: boolean;
        holdRead?: ReturnType<typeof deferred>;
        readStarted: boolean;
        holdChildRead?: ReturnType<typeof deferred>;
        childReadStarted?: ReturnType<typeof deferred>;
        failReads: boolean;
        failFirstPage?: boolean;
        staleFirstPageRoot?: FixtureRow;
        holdSearch?: ReturnType<typeof deferred>;
        searchStarted?: boolean;
      }
    | undefined;
  beforeAll(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    web = await startProcess(
      [
        "bun",
        "run",
        "vite",
        "dev",
        ".",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--strictPort",
      ],
      {
        cwd: `${new URL("../..", import.meta.url).pathname}/apps/web`,
        env: { VITE_API_BASE_URL: "" },
        ready: async () => (await fetch(baseUrl).catch(() => null))?.ok === true,
        timeoutMs: 45_000,
      },
    );
    browser = await chromium.launch();
    page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      reducedMotion: "reduce",
    });
    page.on("pageerror", (error) => console.error("Browser page error:", error.message));
    page.on("console", async (message) => {
      if (message.type() === "error")
        for (const argument of message.args()) {
          console.error(
            await argument
              .evaluate((value) => (value instanceof Error ? value.stack : String(value)))
              .catch(() => "Unavailable console error"),
          );
        }
    });
    await page.addInitScript(() => {
      if (location.origin !== "null")
        localStorage.setItem("opengeni.accessKey", "configured-test-placeholder");
    });
    await page.route(`${baseUrl}/v1/**`, async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      const json = (body: unknown, status = 200) =>
        route.fulfill({
          status,
          contentType: "application/json",
          headers: { "x-opengeni-api-contract": OPENGENI_API_CONTRACT_REVISION },
          body: JSON.stringify(body),
        });
      const workspace = {
        id: workspaceId,
        accountId,
        kind: "shared",
        name: "Compact view verification",
        slug: "compact-view",
        settings: {},
        agentInstructions: null,
        inferenceControl: control,
        defaultRigId: null,
        createdAt: now,
        updatedAt: now,
      };
      if (path === "/v1/config/client")
        return json({
          apiContractRevision: OPENGENI_API_CONTRACT_REVISION,
          productAccessMode: "configured",
          auth: { mode: "none" },
          defaultModel: "scripted-model",
          allowedModels: ["scripted-model"],
          models: [],
          defaultReasoningEffort: "low",
          allowedReasoningEfforts: ["low"],
          mcpServers: [],
          fileUploads: { enabled: false, maxSizeBytes: 1048576 },
          structuredServices: { fileSystem: false, git: false, terminalEvents: false },
        });
      if (path === "/v1/access/me")
        return json({
          mode: "configured",
          subjectId: "fixture",
          subjectLabel: "Fixture",
          accountGrants: [
            {
              accountId,
              subjectId: "fixture",
              role: "owner",
              permissions: ["account:admin", "workspace:admin"],
            },
          ],
          workspaceGrants: [workspaceId, otherWorkspaceId].map((grantedWorkspaceId) => ({
            workspaceId: grantedWorkspaceId,
            accountId,
            subjectId: "fixture",
            permissions: ["workspace:admin", "sessions:read", "sessions:write"],
          })),
          defaultAccountId: accountId,
          defaultWorkspaceId: workspaceId,
        });
      const otherWorkspace = {
        ...workspace,
        id: otherWorkspaceId,
        name: "Other workspace",
        slug: "other",
      };
      if (path === "/v1/workspaces") return json([workspace, otherWorkspace]);
      if (path === `/v1/workspaces/${workspaceId}`) return json(workspace);
      if (path === `/v1/workspaces/${otherWorkspaceId}`) return json(otherWorkspace);
      if (archiveFixture && path.endsWith(`/sessions/${archiveFixture.root.id}/archive`)) {
        const fixture = archiveFixture;
        fixture.mutationStarted = true;
        await fixture.mutation?.promise;
        fixture.root = {
          ...fixture.root,
          archived: route.request().postDataJSON().archived,
          archivedAt: route.request().postDataJSON().archived ? now : null,
          archiveVersion: fixture.root.archiveVersion + 1,
        };
        return json(fixture.root);
      }
      if (path.endsWith("/sessions")) {
        listRequests.push(url);
        if (path.includes(otherWorkspaceId))
          return json({
            sessions: [],
            pinned: [],
            nextCursor: null,
            filtersApplied: true,
          });
        const sortBy = url.searchParams.get("sortBy") ?? "updatedAt";
        const archiveStatus = url.searchParams.get("archiveStatus") ?? "active";
        const fixture = archiveFixture;
        if (fixture && url.searchParams.get("parentSessionId") === fixture.root.id) {
          const hold = fixture.holdChildRead;
          fixture.holdChildRead = undefined;
          fixture.childReadStarted?.resolve();
          await hold?.promise;
        }
        let selected = (
          fixture ? [fixture.root, ...fixture.children, ...fixture.peers] : rows
        ).filter(
          (row) =>
            archiveStatus === "all" ||
            (fixture && row.rootSessionId === fixture.root.id
              ? fixture.root.archived
              : row.archived) ===
              (archiveStatus === "archived"),
        );
        const search = url.searchParams.get("search");
        if (search) selected = selected.filter((row) => row.title.includes(search));
        if (url.searchParams.get("parentSessionId") === "null")
          selected = selected.filter((row) => row.parentSessionId === null);
        else if (url.searchParams.has("parentSessionId"))
          selected = selected.filter(
            (row) => row.parentSessionId === url.searchParams.get("parentSessionId"),
          );
        if (url.searchParams.get("pinsOnly")) selected = [];
        selected.sort((a, b) =>
          sortBy === "name"
            ? a.title.localeCompare(b.title)
            : Date.parse(b[sortBy as "createdAt" | "updatedAt"]) -
              Date.parse(a[sortBy as "createdAt" | "updatedAt"]),
        );
        const offset = Number(url.searchParams.get("cursor") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? 50);
        const response = {
          sessions: selected
            .slice(offset, offset + limit)
            .map((row) =>
              fixture?.staleFirstPageRoot &&
              limit === 50 &&
              url.searchParams.get("parentSessionId") === "null" &&
              row.id === fixture.root.id
                ? fixture.staleFirstPageRoot
                : row,
            ),
          pinned: [],
          nextCursor: offset + limit < selected.length ? String(offset + limit) : null,
          sortBy,
          archiveStatus,
          filtersApplied: true,
        };
        if (fixture && search) {
          const hold = fixture.holdSearch;
          fixture.holdSearch = undefined;
          fixture.searchStarted = true;
          await hold?.promise;
        }
        if (fixture && !search && url.searchParams.get("parentSessionId") === "null") {
          const hold = fixture.holdRead;
          fixture.holdRead = undefined;
          fixture.readStarted = true;
          await hold?.promise;
          if (fixture.failReads || (fixture.failFirstPage && limit === 50))
            return json({ message: "Deliberate read failure" }, 500);
        }
        return json(response);
      }
      if (path.endsWith("/session-message-search"))
        return json({
          matches: [],
          nextCursor: null,
          hasMore: false,
          scannedMessages: 0,
          matchedMessageCount: 0,
          matchedOccurrenceCount: 0,
          countIsExact: true,
        });
      if (path.endsWith("/channels"))
        return json([
          {
            id: projectId,
            workspaceId,
            name: "Empty project",
            position: 0,
            pinned: false,
            createdAt: now,
            updatedAt: now,
          },
        ]);
      if (path.endsWith("/events/stream"))
        return route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" });
      if (path.endsWith("/model-catalog") || path.endsWith("/models")) return json({ models: [] });
      if (path.endsWith("/capabilities")) return json({ items: [], installations: [] });
      if (path.endsWith("/skills")) return json({ skills: [] });

      if (path.endsWith("/connections")) return json({ connections: [] });
      if (path.endsWith("/integrations")) return json({ integrations: [] });
      if (path.endsWith("/connection-authorities")) return json({ authorities: [] });
      if (path.endsWith("/new-session-draft"))
        return json({
          revision: 0,
          text: "",
          resources: [],
          tools: [],
          toolsProvided: false,
          model: "scripted-model",
          reasoningEffort: "low",
          latencyMode: "standard",
          options: {},
          selectionHistory: { projects: [] },
          updatedAt: null,
        });
      if (path.endsWith("/realtime-model-catalog")) return json({ models: [] });
      if (path.endsWith("/knowledge/entries/search")) return json({ items: [], nextCursor: null });
      if (path.endsWith("/github/app"))
        return json({ configured: false, missing: [], installUrl: null });
      if (path.endsWith("/connections/github")) return json({ enabled: false, connection: null });
      if (path.endsWith("/live-events/stream"))
        return route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" });
      if (path.endsWith("/machines"))
        return json({ machines: [], activeSandboxId: null, activeEpoch: 0 });
      if (/\/(variable-sets|rigs|machines|sandboxes|repositories)$/.test(path)) return json([]);
      return json({ message: "Not supplied by browser fixture" }, 404);
    });
    await page.goto(`${baseUrl}/workspaces/${workspaceId}/sessions`, { waitUntil: "networkidle" });
    // The rail renders before draft hydration finishes the composer's initial autofocus.
    await page
      .getByRole("textbox", { name: "Message the agent", exact: true })
      .and(page.locator(":focus"))
      .waitFor();
  }, 60_000);
  afterEach(async () => {
    // A handler clears its fixture field when consuming a gate, so cleanup
    // must retain the resolver independently until the gate actually settles.
    releaseFixtureGates();
    archiveFixture = undefined;
    // Retire the old document before the next case installs another fixture;
    // released requests must not trigger follow-up reads against that fixture.
    if (page && !page.isClosed()) await page.goto("about:blank");
  });
  afterAll(async () => {
    releaseFixtureGates();
    await Promise.allSettled([browser?.close(), web?.stop()]);
  });

  const choose = async (menu: string, choice: string) => {
    // Keep keyboard mode and wait for Radix's focus handoffs before the next key.
    await page.getByRole("button", { name: /^Session view/ }).press("Enter");
    await page.getByRole("menuitem").first().and(page.locator(":focus")).waitFor();
    await page.getByRole("menuitem", { name: new RegExp(`^${menu}`) }).focus();
    await page.keyboard.press("ArrowRight");
    await page.getByRole("menuitemradio").first().and(page.locator(":focus")).waitFor();
    await page.getByRole("menuitemradio", { name: choice, exact: true }).press("Enter");
    await page.getByRole("menu").waitFor({ state: "hidden" });
    await page
      .getByRole("button", { name: /^Session view/ })
      .and(page.locator(":focus"))
      .waitFor();
  };
  test("sorts pages, persists preferences, filters archives, and controls empty project groups", async () => {
    const rail = page.locator("[data-sessionpin-session-list]");
    await rail
      .locator("a[data-session-row]")
      .first()
      .waitFor({ timeout: 10_000 })
      .catch(async (error) => {
        console.error(
          "Route diagnostic",
          page.url(),
          (await page.locator("body").innerText()).slice(0, 2500),
        );
        throw error;
      });
    await choose("Group by", "None");
    await choose("Sort by", "Name");
    await page.waitForFunction(() =>
      document
        .querySelector("[data-sessionpin-session-list] a[data-session-row]")
        ?.textContent?.includes("Session 01"),
    );
    expect(listRequests.some((url) => url.searchParams.get("sortBy") === "name")).toBe(true);
    await rail
      .getByRole("button", { name: "Load older sessions in sessions", exact: true })
      .click();
    await rail.getByText("Session 64", { exact: true }).waitFor();
    const titles = await rail.locator("a[data-session-row]").allTextContents();
    expect(titles.length).toBe(64);
    expect(titles[0]).toContain("Session 01");
    expect(titles.at(-1)).toContain("Session 64");
    await page.reload({ waitUntil: "networkidle" });
    await page
      .getByRole("textbox", { name: "Message the agent", exact: true })
      .and(page.locator(":focus"))
      .waitFor();
    await page.getByRole("button", { name: /^Session view/ }).click();
    expect(await page.getByRole("menuitem", { name: /^Sort by/ }).innerText()).toContain("Name");
    expect(
      await page.getByRole("menuitemcheckbox", { name: "Show empty groups" }).isDisabled(),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await choose("Status", "Archived");
    await rail.getByText("Session 00", { exact: true }).waitFor();
    expect(await rail.locator("a[data-session-row]").count()).toBe(1);
    await choose("Status", "All");
    await choose("Group by", "Project");
    expect(await rail.getByRole("group", { name: "Empty project", exact: true }).count()).toBe(0);
    await page.getByRole("button", { name: /^Session view/ }).click();
    await page.getByRole("menuitemcheckbox", { name: "Show empty groups" }).click();
    await rail.getByRole("group", { name: "Empty project", exact: true }).waitFor();
    await page.getByRole("button", { name: /^Session view/ }).click();
    await page.screenshot({
      path: "test-results/compact-session-view-route-desktop.png",
      fullPage: true,
    });
    expect(
      await page
        .getByRole("menu")
        .first()
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
  }, 45_000);

  const invalidate = async () => {
    await page.evaluate(async (targetWorkspaceId) => {
      const modulePath = "/src/lib/session-list-invalidation.ts";
      const { notifySessionListChanged } = await import(modulePath);
      notifySessionListChanged({ workspaceId: targetWorkspaceId, sessionId: "remote-change" });
    }, workspaceId);
  };
  const settleRead = async () => {
    await page.waitForLoadState("networkidle");
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
  };

  for (const { localArchived, continuationFirst } of [true, false].flatMap((archived) =>
    [false, true].map((first) => ({ localArchived: archived, continuationFirst: first })),
  )) {
    test(`retained local ${localArchived ? "archive" : "restore"} receipt reconciles browse children independently of global search${continuationFirst ? " with stale first-page overlap" : ""}`, async () => {
      const root = {
        ...rows[0]!,
        title: "Nonmatching root",
        archived: !localArchived,
        treeStats: { directChildren: 55, totalDescendants: 55, truncated: false },
      };
      archiveFixture = {
        root,
        children: Array.from({ length: 55 }, (_, index) => ({
          ...rows[1]!,
          id: `55555555-5555-4555-8555-${String(index).padStart(12, "0")}`,
          rootSessionId: root.id,
          parentSessionId: root.id,
          title: `Needle ${String(index).padStart(2, "0")}`,
          archived: false,
        })),
        peers: continuationFirst
          ? Array.from({ length: 55 }, (_, index) => ({
              ...rows[index + 1]!,
              title: `Unrelated ${String(index).padStart(2, "0")}`,
              archived: !localArchived,
            }))
          : [],
        mutationStarted: false,
        readStarted: false,
        failReads: false,
      };
      await page.goto(`${baseUrl}/workspaces/${workspaceId}/sessions`, {
        waitUntil: "networkidle",
      });
      await page
        .getByRole("textbox", { name: "Message the agent", exact: true })
        .and(page.locator(":focus"))
        .waitFor();
      await choose("Group by", "None");
      await choose("Status", localArchived ? "Active" : "Archived");
      const rail = page.locator("[data-sessionpin-session-list]");
      const matchingChildren = rail.locator("a[data-session-row]").filter({ hasText: /Needle \d/ });
      const rootRow = rail.locator(`a[data-session-row][href$="/${root.id}"]`);
      await rootRow.waitFor();
      await rootRow
        .locator("xpath=../..")
        .getByRole("button", { name: "Expand spawned sessions" })
        .click();
      await rail.getByText("Needle 00", { exact: true }).waitFor();
      expect(await matchingChildren.count()).toBe(50);
      archiveFixture.mutation = deferred();
      await rootRow.hover();
      await rail
        .getByRole("button", {
          name: localArchived ? "Archive session" : "Restore session",
          exact: true,
        })
        .and(page.locator(`[data-session-actions="${root.id}"]`))
        .click();
      await page.waitForTimeout(50);
      expect(archiveFixture.mutationStarted).toBe(true);
      const openSearch = async (query: string) => {
        await page.getByRole("button", { name: "Search sessions", exact: true }).first().click();
        const dialog = page.getByRole("dialog", { name: "Search sessions", exact: true });
        await dialog
          .getByRole("searchbox", { name: "Search session titles and messages" })
          .fill(query);
        return dialog;
      };
      const dialog = await openSearch("Needle");
      const results = dialog.locator("[data-search-result]");
      await dialog.getByRole("button", { name: /Needle 00/ }).waitFor();
      // Global search is flat and defaults to all statuses. Its child-only
      // results are independent of the rail's pending tree transition.
      expect(await results.count()).toBe(20);
      expect(await dialog.getByText("Nonmatching root", { exact: true }).count()).toBe(0);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      // Start a branch refresh while the mutation is pending, but let the
      // server evaluate its archive filter only after that mutation commits.
      // The resulting empty child page must be refreshed when the root later
      // returns through a continuation, even if the first page stays stale.
      const delayedChildren = deferred();
      archiveFixture.holdChildRead = delayedChildren;
      archiveFixture.childReadStarted = deferred();
      await invalidate();
      await archiveFixture.childReadStarted.promise;
      // Neither search results nor a successful browse read revive a pending tree.
      expect(await matchingChildren.count()).toBe(0);
      expect(await rootRow.count()).toBe(0);
      const pendingRows = await rail.locator("a[data-session-row]").count();
      expect(pendingRows).toBe(continuationFirst ? 49 : 0);
      // Start another browse read BEFORE completion, but deliver it AFTER
      // the successful receipt and its deliberately failed refresh.
      const delayed = deferred();
      archiveFixture.holdRead = delayed;
      archiveFixture.readStarted = false;
      await invalidate();
      await page.waitForTimeout(100);
      expect(archiveFixture.readStarted).toBe(true);
      // Pending transitions cannot be revived by an invalidation.
      expect(await matchingChildren.count()).toBe(0);
      expect(await rail.locator("a[data-session-row]").count()).toBe(pendingRows);
      archiveFixture.failReads = true;
      archiveFixture.mutation.resolve();
      await page
        .getByText(localArchived ? "Chat archived" : "Chat restored", { exact: true })
        .waitFor();
      archiveFixture.failReads = false;
      const [emptyChildrenResponse] = await Promise.all([
        page.waitForResponse((response) => {
          const url = new URL(response.url());
          return (
            url.pathname.endsWith("/sessions") &&
            url.searchParams.get("parentSessionId") === root.id
          );
        }),
        Promise.resolve().then(() => delayedChildren.resolve()),
      ]);
      expect((await emptyChildrenResponse.json()).sessions).toHaveLength(0);
      delayed.resolve();
      await settleRead();
      expect(await matchingChildren.count()).toBe(0);
      expect(await rootRow.count()).toBe(0);
      expect(await rail.locator("a[data-session-row]").count()).toBe(pendingRows);

      // Another client reverses revision 1 to revision 2. Search cannot retire
      // the rail receipt; only accepted browse evidence can reconcile the tree.
      archiveFixture.root = { ...archiveFixture.root, archived: !localArchived, archiveVersion: 2 };
      if (continuationFirst) {
        const restoredChildren = deferred();
        archiveFixture.holdChildRead = restoredChildren;
        archiveFixture.childReadStarted = deferred();
        // Keep the accepted first page from BEFORE mutation completion. Only
        // the 100-row continuation may confirm membership after the reversal;
        // it overlaps cached roots and adds six continuation-only roots.
        archiveFixture.failFirstPage = true;
        await invalidate();
        await settleRead();
        expect(await matchingChildren.count()).toBe(0);
        await rail.getByText("Unrelated 00", { exact: true }).waitFor();
        const [continuationResponse] = await Promise.all([
          page.waitForResponse((response) => {
            const url = new URL(response.url());
            return url.pathname.endsWith("/sessions") && url.searchParams.get("limit") === "100";
          }),
          rail.getByRole("button", { name: /^Load older sessions in/ }).click(),
        ]);
        const continuationPage = await continuationResponse.json();
        expect(
          continuationPage.sessions.find((row: FixtureRow) => row.id === root.id),
        ).toMatchObject({
          archived: !localArchived,
          archiveVersion: 2,
        });
        await rootRow.waitFor();
        await rail.getByText("Unrelated 54", { exact: true }).waitFor();
        await archiveFixture.childReadStarted.promise;
        // Root membership and branch materialization are separate commits.
        // Keep the restoring branch response in flight to prove that seeing
        // the root is not evidence that its 50 children have rendered yet.
        expect(await matchingChildren.count()).toBe(0);
        const [restoredChildrenResponse] = await Promise.all([
          page.waitForResponse((response) => {
            const url = new URL(response.url());
            return (
              url.pathname.endsWith("/sessions") &&
              url.searchParams.get("parentSessionId") === root.id
            );
          }),
          Promise.resolve().then(() => restoredChildren.resolve()),
        ]);
        expect((await restoredChildrenResponse.json()).sessions).toHaveLength(50);
        await rail.getByText("Needle 00", { exact: true }).waitFor();
        await settleRead();
        expect(await matchingChildren.count()).toBe(50);
        expect(await rail.getByText("Needle 00", { exact: true }).count()).toBe(1);
        expect(await rootRow.count()).toBe(1);
        // An unrelated failed first-page refresh cannot erase the newer
        // per-row continuation proof or globally retire the local receipt.
        await invalidate();
        await settleRead();
        expect(await matchingChildren.count()).toBe(50);
        archiveFixture.failFirstPage = false;
        // Even a successful stale first-page invalidation cannot replace the
        // continuation's newer archive revision with the pre-mutation root.
        archiveFixture.staleFirstPageRoot = root;
        await invalidate();
        await settleRead();
        expect(await rootRow.count()).toBe(1);
        expect(await matchingChildren.count()).toBe(50);
        archiveFixture.staleFirstPageRoot = undefined;
      }
      for (let refresh = 0; refresh < 2; refresh++) {
        await invalidate();
        await rail.getByText("Needle 00", { exact: true }).waitFor();
        await settleRead();
        expect(await rootRow.count()).toBe(1);
      }
      await rail
        .getByRole("list", { name: "Spawned sessions from Nonmatching root", exact: true })
        .getByRole("button", { name: "Show more", exact: true })
        .click();
      await rail.getByText("Needle 54", { exact: true }).waitFor();
      expect(await matchingChildren.count()).toBe(55);
      expect(await rail.locator("a[data-session-row]").count()).toBe(continuationFirst ? 111 : 56);
      await invalidate();
      await settleRead();
      expect(await matchingChildren.count()).toBe(55);
      expect(await rail.locator("a[data-session-row]").count()).toBe(continuationFirst ? 111 : 56);
      // Failure cannot retire the receipt or grant freshness to old rows.
      archiveFixture.failReads = true;
      await invalidate();
      await settleRead();
      expect(await matchingChildren.count()).toBe(55);
      expect(await rail.locator("a[data-session-row]").count()).toBe(continuationFirst ? 111 : 56);
      archiveFixture.failReads = false;
      const commitMissingSearch = async (edit: () => Promise<unknown>) => {
        // networkidle can already be satisfied while the query debounce has
        // not fired. Wait for this query's two reads, then its committed UI.
        const [titleResponse, messageResponse] = await Promise.all([
          page.waitForResponse((response) => {
            const url = new URL(response.url());
            return (
              url.pathname === `/v1/workspaces/${workspaceId}/sessions` &&
              url.searchParams.get("search") === "Missing"
            );
          }),
          page.waitForResponse((response) => {
            const url = new URL(response.url());
            return (
              url.pathname === `/v1/workspaces/${workspaceId}/session-message-search` &&
              url.searchParams.get("query") === "Missing" &&
              url.searchParams.get("groupBy") === "session"
            );
          }),
          edit(),
        ]);
        expect(titleResponse.status()).toBe(200);
        expect(messageResponse.status()).toBe(200);
        expect((await titleResponse.json()).sessions).toHaveLength(0);
        expect((await messageResponse.json()).matches).toHaveLength(0);
        await dialog
          .getByRole("status")
          .filter({ hasText: /^Showing results for/ })
          .waitFor({ state: "hidden" });
        await dialog
          .getByText("No matching sessions. Try a shorter phrase or different words.", {
            exact: true,
          })
          .waitFor();
      };
      await commitMissingSearch(() => openSearch("Missing"));
      expect(await results.count()).toBe(0);
      expect(await matchingChildren.count()).toBe(55);
      // A child-only response for the previous dialog query must not populate
      // a newer query or change the independently expanded browse hierarchy.
      const oldSearch = deferred();
      archiveFixture.holdSearch = oldSearch;
      archiveFixture.searchStarted = false;
      await dialog.getByRole("searchbox").fill("Needle");
      await waitFor(() => archiveFixture?.searchStarted === true);
      // Release the obsolete read only after Missing commits. During its
      // debounce, Needle is still the active query and may legitimately render.
      await commitMissingSearch(() => dialog.getByRole("searchbox").fill("Missing"));
      oldSearch.resolve();
      await settleRead();
      expect(await results.count()).toBe(0);
      expect(await matchingChildren.count()).toBe(55);
      await dialog.getByRole("searchbox").fill("Needle");
      await dialog.getByRole("button", { name: /Needle 00/ }).waitFor();
      await dialog.getByRole("button", { name: "More title results" }).click();
      await dialog.getByRole("button", { name: /Needle 20/ }).waitFor();
      await dialog.getByRole("button", { name: "More title results" }).click();
      await dialog.getByRole("button", { name: /Needle 54/ }).waitFor();
      expect(await results.count()).toBe(15);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      // A delayed accepted-source read must not cross workspace identity, even
      // when returning to the original workspace after its response arrives.
      const oldWorkspaceRead = deferred();
      archiveFixture.holdRead = oldWorkspaceRead;
      archiveFixture.readStarted = false;
      await invalidate();
      await page.waitForTimeout(100);
      expect(archiveFixture.readStarted).toBe(true);
      await page.getByRole("button", { name: /Switch workspace$/ }).click();
      await page.getByRole("menuitem", { name: /Other workspace/ }).click();
      await page.waitForURL(`**/workspaces/${otherWorkspaceId}/sessions`);
      oldWorkspaceRead.resolve();
      await settleRead();
      expect(await rail.locator("a[data-session-row]").count()).toBe(0);
      await page.getByRole("button", { name: /Switch workspace$/ }).click();
      await page.getByRole("menuitem", { name: /Compact view verification/ }).click();
      await page.waitForURL(`**/workspaces/${workspaceId}/sessions`);
      // Wait for the new workspace composer before reopening global search.
      await page
        .getByRole("textbox", { name: "Message the agent", exact: true })
        .and(page.locator(":focus"))
        .waitFor();
      await settleRead();
      await openSearch("Needle");
      // Late composer hydration must not take focus while search is being entered.
      await settleRead();
      expect(await dialog.getByRole("searchbox").inputValue()).toBe("Needle");
      expect(
        await dialog.getByRole("searchbox").evaluate((input) => input === document.activeElement),
      ).toBe(true);
      await dialog.getByRole("button", { name: /Needle 00/ }).waitFor();
      expect(await matchingChildren.count()).toBe(0);
      expect(
        listRequests
          .filter((url) => url.searchParams.has("parentSessionId"))
          .every((url) => !url.searchParams.get("search")),
      ).toBe(true);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
    }, 45_000);
  }

  test("failure cleanup releases consumed and unconsumed fixture gates", async () => {
    const fixture: Record<string, ReturnType<typeof deferred> | undefined> = {
      mutation: deferred(),
      holdRead: deferred(),
      holdChildRead: deferred(),
      holdSearch: deferred(),
    };
    const requests = Object.entries(fixture).map(async ([name, gate]) => {
      if (name !== "mutation") fixture[name] = undefined;
      await gate!.promise;
      return name;
    });
    expect(fixture.holdChildRead).toBeUndefined();
    await expect(
      (async () => {
        try {
          throw new Error("simulated assertion failure after consuming a gate");
        } finally {
          releaseFixtureGates();
        }
      })(),
    ).rejects.toThrow("simulated assertion failure");
    expect(await Promise.all(requests)).toEqual([
      "mutation",
      "holdRead",
      "holdChildRead",
      "holdSearch",
    ]);
    expect(pendingFixtureGateReleases.size).toBe(0);

    // Releasing one case must not pre-resolve a gate registered by the next.
    const next = deferred();
    let nextSettled = false;
    const nextRequest = next.promise.then(() => {
      nextSettled = true;
    });
    await Promise.resolve();
    expect(nextSettled).toBe(false);
    releaseFixtureGates();
    await nextRequest;
    expect(nextSettled).toBe(true);
    expect(pendingFixtureGateReleases.size).toBe(0);
  });
});
