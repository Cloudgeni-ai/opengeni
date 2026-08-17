// Phone-viewport browser proof for the compact rig image-readiness projection.
// It preserves the real summary response, changes only the selected rig's
// coarse readiness state, and proves adaptive polling stops once ready.
//
// Run against scripts/rig-ui-stack.ts: bun scripts/bench-rig-readiness-browser.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

type State = {
  apiPort: number;
  webPort: number;
  workspaceId: string;
};

type RigSummary = {
  id: string;
  name: string;
  activeVersion: null | {
    managedSandboxImage: null | {
      backend: string;
      status: string;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

const state = JSON.parse(readFileSync("/tmp/rig-ui-stack.json", "utf8")) as State;
const evidenceDir = new URL("../.agent/evidence/rig-performance/", import.meta.url).pathname;
mkdirSync(evidenceDir, { recursive: true });

function nixChromiumPath(): string | undefined {
  if (spawnSync("sh", ["-lc", "command -v nix"], { stdio: "ignore" }).status !== 0) {
    return undefined;
  }
  const result = spawnSync("nix", ["eval", "--raw", "nixpkgs#chromium.outPath"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 && result.stdout.trim()
    ? `${result.stdout.trim()}/bin/chromium`
    : undefined;
}

async function main(): Promise<void> {
  const realResponse = await fetch(
    `http://127.0.0.1:${state.apiPort}/v1/workspaces/${state.workspaceId}/rigs?view=summary`,
  );
  if (!realResponse.ok) {
    throw new Error(`summary fixture failed: ${realResponse.status}`);
  }
  const summaries = (await realResponse.json()) as RigSummary[];
  const selected = summaries.find((rig) => rig.name === "dev-machine");
  if (!selected?.activeVersion) throw new Error("seeded dev-machine rig is unavailable");

  const { chromium } = await import("playwright");
  const executablePath = nixChromiumPath();
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });

  let requestCount = 0;
  let allowReady = false;
  const requestAtMs: number[] = [];
  const responseBytes: number[] = [];
  const startedAt = performance.now();
  await page.route("**/v1/workspaces/**/rigs*", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== "GET" || url.searchParams.get("view") !== "summary") {
      await route.continue();
      return;
    }
    requestCount += 1;
    requestAtMs.push(performance.now() - startedAt);
    const status = allowReady ? "ready" : "building";
    const body = summaries.map((rig) =>
      rig.id === selected.id && rig.activeVersion
        ? {
            ...rig,
            activeVersion: {
              ...rig.activeVersion,
              managedSandboxImage: { backend: "modal", status },
            },
          }
        : rig,
    );
    const encoded = JSON.stringify(body);
    responseBytes.push(Buffer.byteLength(encoded));
    await route.fulfill({ status: 200, contentType: "application/json", body: encoded });
  });

  const base = `http://127.0.0.1:${state.webPort}/workspaces/${state.workspaceId}`;
  await page.goto(`${base}/sessions`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const select = page
    .locator("select")
    .filter({ has: page.locator("option", { hasText: "Workspace default" }) })
    .first();
  await select.waitFor({ timeout: 15_000 });
  await select.selectOption(selected.id);

  const buildingAt = performance.now() - startedAt;
  await page.getByText("Preparing fast startup.", { exact: true }).waitFor({ timeout: 5_000 });
  const countAtBuilding = requestCount;
  allowReady = true;
  await page.getByText("Fast startup ready.", { exact: true }).waitFor({ timeout: 8_000 });
  const readyAt = performance.now() - startedAt;
  const countAtReady = requestCount;
  await page.waitForTimeout(3_200);
  const countAfterTerminalConfirmation = requestCount;
  await page.waitForTimeout(3_200);
  const countAfterTerminalWait = requestCount;

  const selectedText =
    (await page.getByText("Fast startup ready.", { exact: true }).locator("..").innerText()) ?? "";
  const screenshot = `${evidenceDir}rig-readiness-phone.png`;
  await page.screenshot({ path: screenshot, fullPage: true });
  await browser.close();

  const serialized = JSON.stringify(summaries);
  const report = {
    viewport: { width: 390, height: 844, cpuThrottle: 4 },
    rigCount: summaries.length,
    allRigIdsPreserved: new Set(summaries.map((rig) => rig.id)).size === summaries.length,
    compactProjection: {
      bytes: Buffer.byteLength(serialized),
      containsSetupScript: serialized.includes("setupScript"),
      containsProviderImages: serialized.includes("providerImages"),
      containsProviderImageId: serialized.includes("imageId"),
    },
    transition: {
      buildingVisibleAtMs: Number(buildingAt.toFixed(1)),
      countAtBuilding,
      readyVisibleAtMs: Number(readyAt.toFixed(1)),
      requestCount,
      requestAtMs: requestAtMs.map((value) => Number(value.toFixed(1))),
      responseBytes,
      pollingStoppedAfterReady: countAfterTerminalWait === countAfterTerminalConfirmation,
      countAtReady,
      countAfterTerminalConfirmation,
      countAfterTerminalWait,
      selectedText,
    },
    screenshot,
  };
  writeFileSync("/tmp/rig-readiness-browser.json", `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));

  if (
    !report.allRigIdsPreserved ||
    report.compactProjection.containsSetupScript ||
    report.compactProjection.containsProviderImages ||
    report.compactProjection.containsProviderImageId ||
    !report.transition.pollingStoppedAfterReady ||
    countAtReady < 2
  ) {
    throw new Error("rig readiness browser invariants failed");
  }
}

await main();
