// Playwright screenshot pass for the Rigs UI (M5). Reads the running stack from
// scripts/rig-ui-stack.ts (state file), then captures every rig UI state at 1440
// and 800 px into .agent/evidence/m5-ui/. Re-runnable: edit UI → vite HMRs → run
// this again.
//
// Run: bun scripts/rig-ui-shots.ts
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const STATE_FILE = `${process.env.RIG_UI_STATE_DIR ?? "/tmp"}/rig-ui-stack.json`;
const OUT_DIR = new URL("../.agent/evidence/m5-ui/", import.meta.url).pathname;

type State = { apiPort: number; webPort: number; workspaceId: string; baseUrl: string };

// Playwright's bundled chromium needs system libs that aren't on a bare NixOS
// host; pull them from the store the way scripts/run-browser-e2e.ts does.
function ensureNixLibraryPath() {
  const probe = spawnSync("sh", ["-lc", "command -v nix"], { stdio: "ignore" });
  if (probe.status !== 0) {
    return;
  }
  const attributes = [
    "glib", "nss", "nspr", "dbus", "atk", "at-spi2-core", "cups", "libdrm", "expat", "libxkbcommon",
    "xorg.libX11", "xorg.libXcomposite", "xorg.libXdamage", "xorg.libXext", "xorg.libXfixes",
    "xorg.libXrandr", "xorg.libxcb", "mesa", "pango", "cairo", "alsa-lib", "libgbm", "gtk3", "gdk-pixbuf",
  ];
  const paths = new Set<string>();
  for (const attribute of attributes) {
    for (const suffix of [".out.outPath", ".lib.outPath", ".outPath"]) {
      const result = spawnSync("nix", ["eval", "--raw", `nixpkgs#${attribute}${suffix}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      if (result.status === 0 && result.stdout.trim()) {
        paths.add(`${result.stdout.trim()}/lib`);
      }
    }
  }
  if (paths.size > 0) {
    process.env.LD_LIBRARY_PATH = [[...paths].join(":"), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
  }
}

async function main() {
  const state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
  const { webPort, apiPort, workspaceId } = state;
  mkdirSync(OUT_DIR, { recursive: true });
  ensureNixLibraryPath();

  const rigs = (await (await fetch(`http://127.0.0.1:${apiPort}/v1/workspaces/${workspaceId}/rigs`)).json()) as Array<{ id: string; name: string }>;
  const devRig = rigs.find((rig) => rig.name === "dev-machine");
  const ciRig = rigs.find((rig) => rig.name === "ci-runner");
  if (!devRig || !ciRig) {
    throw new Error(`expected seeded rigs; got ${rigs.map((r) => r.name).join(", ")}`);
  }

  const { chromium } = await import("playwright");
  // Playwright's bundled chromium isn't downloaded on this host; use the nix
  // store chromium (like the staging web-verification recipe).
  const nixChromium = spawnSync("nix", ["eval", "--raw", "nixpkgs#chromium.outPath"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const executablePath = nixChromium.status === 0 && nixChromium.stdout.trim() ? `${nixChromium.stdout.trim()}/bin/chromium` : undefined;
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const base = `http://127.0.0.1:${webPort}/workspaces/${workspaceId}`;

  const shots: Array<{
    name: string;
    url: string;
    intercepts?: (page: import("playwright").Page) => Promise<void>;
    prepare?: (page: import("playwright").Page) => Promise<void>;
  }> = [
    {
      name: "01-list-empty",
      url: `${base}/rigs`,
      intercepts: async (page) => {
        await page.route(`**/v1/workspaces/${workspaceId}/rigs`, (route) =>
          route.request().method() === "GET" ? route.fulfill({ status: 200, contentType: "application/json", body: "[]" }) : route.continue(),
        );
      },
      prepare: async (page) => {
        await page.getByText("No rigs yet").waitFor({ timeout: 15_000 });
      },
    },
    {
      name: "02-list-dense",
      url: `${base}/rigs`,
      prepare: async (page) => {
        await page.getByText("dev-machine").first().waitFor({ timeout: 15_000 });
      },
    },
    {
      name: "03-create-form",
      url: `${base}/rigs`,
      prepare: async (page) => {
        await page.getByRole("button", { name: "New rig" }).first().click();
        await page.getByText(/Image, setup script/).click();
        await page.getByLabel("Setup script").waitFor({ timeout: 10_000 });
      },
    },
    {
      name: "04-detail-overview",
      url: `${base}/rigs/${devRig.id}`,
      prepare: async (page) => {
        await page.getByText("Health checks").waitFor({ timeout: 15_000 });
      },
    },
    {
      name: "05-detail-setup",
      url: `${base}/rigs/${devRig.id}`,
      prepare: async (page) => {
        await page.getByRole("tab", { name: "Setup" }).click();
        await page.getByText(/Editing the machine doesn't change/).waitFor({ timeout: 10_000 });
      },
    },
    {
      name: "06-detail-versions",
      url: `${base}/rigs/${devRig.id}`,
      prepare: async (page) => {
        await page.getByRole("tab", { name: /Versions/ }).click();
        await page.getByText("Version 12").waitFor({ timeout: 10_000 });
      },
    },
    {
      name: "07-detail-changes",
      url: `${base}/rigs/${devRig.id}`,
      prepare: async (page) => {
        await page.getByRole("tab", { name: /Changes/ }).click();
        await page.getByText("Verified").first().waitFor({ timeout: 10_000 });
      },
    },
    {
      name: "08-change-failing-log",
      url: `${base}/rigs/${devRig.id}`,
      prepare: async (page) => {
        await page.getByRole("tab", { name: /Changes/ }).click();
        await page.getByText("Rejected").first().click();
        await page.getByText("internal tool present").waitFor({ timeout: 10_000 });
      },
    },
    {
      name: "09-detail-unknown-health",
      url: `${base}/rigs/${ciRig.id}`,
      prepare: async (page) => {
        await page.getByText("Not verified").first().waitFor({ timeout: 10_000 });
      },
    },
    {
      name: "10-composer-rig-picker",
      url: `${base}/sessions`,
      prepare: async (page) => {
        const select = page.locator("select").filter({ has: page.locator("option", { hasText: "Workspace default" }) }).first();
        await select.waitFor({ timeout: 15_000 });
        const value = await select.locator("option", { hasText: "dev-machine" }).getAttribute("value");
        if (value) {
          await select.selectOption(value);
        }
        await page.waitForTimeout(300);
      },
    },
    {
      name: "11-permission-denied",
      url: `${base}/rigs`,
      intercepts: async (page) => {
        await page.route("**/v1/access/me", async (route) => {
          const response = await route.fetch();
          const body = await response.json();
          const strip = (grant: Record<string, unknown>) =>
            grant.workspaceId === workspaceId
              ? { ...grant, permissions: (grant.permissions as string[]).filter((p) => p !== "rigs:use" && p !== "rigs:manage" && p !== "workspace:admin") }
              : grant;
          body.workspaceGrants = (body.workspaceGrants as Array<Record<string, unknown>>).map(strip);
          await route.fulfill({ response, json: body });
        });
      },
      prepare: async (page) => {
        await page.getByText(/don't have access to rigs/).waitFor({ timeout: 15_000 });
      },
    },
  ];

  for (const shot of shots) {
    for (const width of [1440, 800]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
      try {
        if (shot.intercepts) {
          await shot.intercepts(page);
        }
        await page.goto(shot.url, { waitUntil: "networkidle", timeout: 30_000 });
        if (shot.prepare) {
          await shot.prepare(page);
        }
        await page.waitForTimeout(250);
        const file = `${OUT_DIR}${shot.name}-${width}.png`;
        await page.screenshot({ path: file, fullPage: true });
        console.log(`[shot] ${shot.name} @ ${width} -> ${file}`);
      } catch (error) {
        console.error(`[shot] FAILED ${shot.name} @ ${width}:`, (error as Error).message);
      } finally {
        await page.close();
      }
    }
  }

  await browser.close();
  console.log("[shots] done");
}

main().catch((error) => {
  console.error("[shots] fatal:", error);
  process.exit(1);
});
