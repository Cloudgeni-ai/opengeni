#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { chromium } from "playwright";

const state = JSON.parse(readFileSync("/tmp/rig-ui-stack.json", "utf8")) as {
  apiPort: number;
  webPort: number;
  workspaceId: string;
};
const apiBase = process.env.RIG_UI_API_ORIGIN ?? `http://127.0.0.1:${state.apiPort}`;
const webBase = process.env.RIG_UI_WEB_ORIGIN ?? `http://127.0.0.1:${state.webPort}`;
const workspaceId = process.env.RIG_UI_WORKSPACE_ID ?? state.workspaceId;
const rigsUrl = `${apiBase}/v1/workspaces/${workspaceId}/rigs`;
const summaries = (await (await fetch(`${rigsUrl}?view=summary`)).json()) as Array<{
  id: string;
  name: string;
}>;
const target = summaries.find((rig) => rig.name.startsWith("perf-huge-"));
if (!target) throw new Error("no maximum-size benchmark rig is available");

const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const rigReads: string[] = [];
  const draftBodies: string[] = [];
  let createBody = "";
  page.on("request", (request) => {
    if (request.method() === "GET" && request.url().includes(`/rigs`)) {
      rigReads.push(request.url());
    }
    if (request.method() === "PUT" && request.url().endsWith("/new-session-draft")) {
      draftBodies.push(request.postData() ?? "");
    }
  });
  await page.route(`**/v1/workspaces/${workspaceId}/sessions`, async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    createBody = route.request().postData() ?? "";
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "perf_probe", message: "Intentional proof" } }),
    });
  });

  await page.goto(`${webBase}/workspaces/${workspaceId}/sessions`, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  const rigSelect = page
    .locator("select")
    .filter({ has: page.locator('option:text-is("Workspace default")') });
  await rigSelect.waitFor({ timeout: 30_000 });
  await rigSelect.selectOption(target.id);
  await page.getByPlaceholder("Describe a task for the agent…").fill("Rig transport proof");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.waitForFunction(() => document.body.textContent?.includes("Intentional proof"), null, {
    timeout: 30_000,
  });

  if (!createBody) throw new Error("session create request was not observed");
  const create = JSON.parse(createBody) as Record<string, unknown>;
  const allBodies = [createBody, ...draftBodies];
  const forbiddenKeys = ["setupScript", "providerImages", "credentialHooks", "checks"];
  const leakedKey = forbiddenKeys.find((key) =>
    allBodies.some((body) => body.includes(`"${key}"`)),
  );
  if (leakedKey) throw new Error(`mobile request leaked full rig field ${leakedKey}`);
  if (create.rigId !== target.id) {
    throw new Error(`create bound ${String(create.rigId)} instead of ${target.id}`);
  }
  if (rigReads.some((url) => /\/rigs\/[0-9a-f-]+$/u.test(new URL(url).pathname))) {
    throw new Error(`selection fetched the full rig: ${rigReads.join(", ")}`);
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        targetRig: target,
        rigReads,
        createBodyBytes: Buffer.byteLength(createBody),
        createBodyGzipBytes: gzipSync(createBody).byteLength,
        draftWriteCount: draftBodies.length,
        maximumDraftBodyBytes: Math.max(0, ...draftBodies.map((body) => Buffer.byteLength(body))),
        exactCreateRigId: create.rigId,
        fullRigDetailFetched: false,
        fullRigFieldsOnMobileWire: false,
        serverResolution:
          "The create API receives only rigId, resolves the active version under workspace RLS, and freezes rigId + rigVersionId on the session.",
        mutationSafety:
          "The session POST was intercepted and failed intentionally; no session, turn, sandbox, or model call was created.",
      },
      null,
      2,
    )}\n`,
  );
  await context.close();
} finally {
  await browser.close();
}
