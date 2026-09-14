import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import { OPENGENI_API_CONTRACT_REVISION } from "@opengeni/sdk";

const workspaceId = "11111111-1111-4111-8111-111111111111";
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

describe("compact session view on the live local workspace route (API fixture)", () => {
  let web: StartedProcess;
  let browser: Browser;
  let page: Page;
  let baseUrl: string;
  const listRequests: URL[] = [];
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
          workspaceGrants: [
            {
              workspaceId,
              accountId,
              subjectId: "fixture",
              permissions: ["workspace:admin", "sessions:read", "sessions:write"],
            },
          ],
          defaultAccountId: accountId,
          defaultWorkspaceId: workspaceId,
        });
      if (path === "/v1/workspaces") return json([workspace]);
      if (path === `/v1/workspaces/${workspaceId}`) return json(workspace);
      if (path.endsWith("/sessions")) {
        listRequests.push(url);
        const sortBy = url.searchParams.get("sortBy") ?? "updatedAt";
        const archiveStatus = url.searchParams.get("archiveStatus") ?? "active";
        let selected = rows.filter(
          (row) => archiveStatus === "all" || row.archived === (archiveStatus === "archived"),
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
        return json({
          sessions: selected.slice(offset, offset + limit),
          pinned: [],
          nextCursor: offset + limit < selected.length ? String(offset + limit) : null,
          sortBy,
          archiveStatus,
          filtersApplied: true,
        });
      }
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
      if (path.endsWith("/packs")) return json({ packs: [], installations: [] });
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
  }, 60_000);
  afterAll(async () => {
    await Promise.allSettled([browser?.close(), web?.stop()]);
  });

  const choose = async (menu: string, choice: string) => {
    await page.getByRole("button", { name: /^Session view/ }).click();
    await page.getByRole("menuitem", { name: new RegExp(`^${menu}`) }).focus();
    await page.keyboard.press("ArrowRight");
    await page.getByRole("menuitemradio", { name: choice, exact: true }).click();
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
      path: "/workspace/compact-session-view-route-desktop.png",
      fullPage: true,
    });
    expect(
      await page
        .getByRole("menu")
        .first()
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
  }, 45_000);
});
