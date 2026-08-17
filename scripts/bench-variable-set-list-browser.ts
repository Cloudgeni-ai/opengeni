#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { chromium } from "playwright";
import { MAX_ENVIRONMENTS_PER_WORKSPACE, MAX_VARIABLES_PER_ENVIRONMENT } from "@opengeni/core";
import { OPENGENI_API_CONTRACT_HEADER, OPENGENI_API_CONTRACT_REVISION } from "@opengeni/sdk";

const state = JSON.parse(readFileSync("/tmp/rig-ui-stack.json", "utf8")) as {
  apiPort: number;
  webPort: number;
  workspaceId: string;
};
const apiBase = `http://127.0.0.1:${state.apiPort}`;
const webBase = `http://127.0.0.1:${state.webPort}`;
const listUrl = `${apiBase}/v1/workspaces/${state.workspaceId}/variable-sets`;
const sessionUrl = `${webBase}/workspaces/${state.workspaceId}/sessions`;
const marker = "secret-value-that-must-never-reach-a-list-response";
const createdIds: string[] = [];

try {
  const existing = await list();
  const missingCount = MAX_ENVIRONMENTS_PER_WORKSPACE - existing.length;
  for (let offset = 0; offset < missingCount; offset += 4) {
    await Promise.all(
      Array.from({ length: Math.min(4, missingCount - offset) }, (_, index) =>
        createSet(offset + index),
      ),
    );
  }

  const apiSamples: number[] = [];
  let body = "";
  for (let sample = 0; sample < 7; sample += 1) {
    const startedAt = performance.now();
    const response = await fetch(listUrl);
    body = await response.text();
    apiSamples.push(performance.now() - startedAt);
    if (!response.ok) throw new Error(`variable-set list failed: ${response.status}`);
  }
  if (body.includes(marker)) throw new Error("generic variable-set list leaked a plaintext value");
  const sets = JSON.parse(body) as Array<{
    id: string;
    name: string;
    variables: Array<{ name: string }>;
  }>;
  const expectedVariables = sets.reduce((sum, set) => sum + set.variables.length, 0);

  const browser = await chromium.launch();
  const browserSamples: Array<Record<string, unknown>> = [];
  try {
    for (let sample = 0; sample < 3; sample += 1) {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      const startedAt = performance.now();
      await page.goto(sessionUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForFunction(
        (expected) => {
          const select = [...document.querySelectorAll<HTMLSelectElement>("select")].find(
            (candidate) => candidate.options[0]?.textContent === "No variable set",
          );
          return select?.options.length === expected + 1;
        },
        sets.length,
        { timeout: 30_000, polling: 10 },
      );
      await page.evaluate(() => new Promise(requestAnimationFrame));
      const usableMs = performance.now() - startedAt;
      const proof = await page.evaluate(
        (expectedNames) => {
          const select = [...document.querySelectorAll<HTMLSelectElement>("select")].find(
            (candidate) => candidate.options[0]?.textContent === "No variable set",
          );
          const labels = [...(select?.options ?? [])].map((option) => option.textContent ?? "");
          return {
            optionCount: labels.length,
            namesPresent: expectedNames.every((name) =>
              labels.some((label) => label.startsWith(name)),
            ),
            documentOverflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
          };
        },
        sets.map((set) => set.name),
      );
      browserSamples.push({ sample: sample + 1, usableMs, errors, ...proof });
      await context.close();
    }
  } finally {
    await browser.close();
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        modelCalls: 0,
        invariant:
          "Every variable set and variable name remains available; generic list transport must not contain plaintext values.",
        variableSets: sets.length,
        variableMetadataEntries: expectedVariables,
        rawBytes: Buffer.byteLength(body),
        gzipBytes: gzipSync(body).byteLength,
        apiMs: distribution(apiSamples),
        mobileUsableMs: distribution(browserSamples.map((sample) => Number(sample.usableMs))),
        browserSamples,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await Promise.allSettled(createdIds.map((id) => removeSet(id)));
}

async function list(): Promise<Array<{ id: string }>> {
  const response = await fetch(listUrl);
  if (!response.ok) throw new Error(`variable-set list failed: ${response.status}`);
  return (await response.json()) as Array<{ id: string }>;
}

async function createSet(index: number): Promise<void> {
  const response = await fetch(listUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
    },
    body: JSON.stringify({
      name: `perf-variable-set-${String(index + 1).padStart(2, "0")}`,
      description: "d".repeat(2_000),
      variables: Array.from({ length: MAX_VARIABLES_PER_ENVIRONMENT }, (_, variable) => ({
        name: `PERF_${String(index + 1).padStart(2, "0")}_${String(variable + 1).padStart(3, "0")}`,
        value: `${marker}-${index}-${variable}`,
      })),
    }),
  });
  const text = await response.text();
  if (response.status !== 201)
    throw new Error(`variable-set create failed: ${response.status} ${text}`);
  createdIds.push((JSON.parse(text) as { id: string }).id);
}

async function removeSet(id: string): Promise<void> {
  const response = await fetch(`${listUrl}/${id}`, {
    method: "DELETE",
    headers: { [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION },
  });
  await response.arrayBuffer();
  if (!response.ok) throw new Error(`variable-set cleanup failed: ${response.status}`);
}

function distribution(values: number[]) {
  const ordered = [...values].sort((left, right) => left - right);
  const at = (fraction: number) => ordered[Math.ceil(ordered.length * fraction) - 1]!;
  return { min: ordered[0], p50: at(0.5), p95: at(0.95), max: ordered.at(-1) };
}
