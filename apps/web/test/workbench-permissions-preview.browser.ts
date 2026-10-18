import { mkdir } from "node:fs/promises";
import { chromium, expect } from "playwright/test";
import type { PreviewRole } from "./workbench-permissions-preview-context";

const output = process.env.OPENGENI_PERMISSIONS_PREVIEW_OUTPUT;
if (output) await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  ...(process.env.OPENGENI_PREVIEW_CHROMIUM
    ? { executablePath: process.env.OPENGENI_PREVIEW_CHROMIUM }
    : {}),
  args: ["--no-sandbox"],
});
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(
      `${process.env.OPENGENI_PERMISSIONS_PREVIEW_URL ?? "http://127.0.0.1:4347"}/test/workbench-permissions-preview.html`,
      { waitUntil: "networkidle" },
    );
    await expect(page.getByText("Release verification runbook", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add knowledge", exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Knowledge", exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.permissionPreview.violations)).toEqual([]);
    const reads = await page.evaluate(() => window.permissionPreview.requests);
    expect(reads.some((item) => item.method === "knowledge")).toBe(true);
    expect(
      reads.some((item) =>
        ["review-groups", "rig", "rigs", "authority:rig", "authority:connected_machine"].includes(
          item.method,
        ),
      ),
    ).toBe(false);
    expect(
      reads.some(
        (item) => (item.request as { view?: string } | undefined)?.view === "needs_review",
      ),
    ).toBe(false);
    if (output) await page.screenshot({ path: `${output}/reader-${width}.png`, fullPage: true });

    await page.getByRole("button", { name: "Release verification runbook", exact: true }).click();
    await expect(
      page.getByText(
        "Published knowledge remains readable without review or resource-management authority.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
    await page.getByRole("link", { name: "Knowledge", exact: true }).click();
    await expect(page.getByRole("searchbox", { name: "Search knowledge" })).toBeVisible();

    await page.evaluate(() => window.permissionPreview.setRole("manager"));
    await expect(page.getByRole("button", { name: "Add knowledge", exact: true })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Knowledge, needs review", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => window.permissionPreview.resourceState))
      .toEqual({ rigs: 1, machines: 1, blocked: false });
    expect(
      await page.evaluate(() =>
        window.permissionPreview.requests.some((item) => item.method === "review-groups"),
      ),
    ).toBe(true);
    if (output) await page.screenshot({ path: `${output}/manager-${width}.png`, fullPage: true });
    await page.getByRole("tab", { name: /Review/ }).click();
    await expect(page.getByText("Proposed support handoff", { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Library", exact: true }).click();

    for (const role of ["rigs", "machines", "reader"] satisfies PreviewRole[]) {
      await page.evaluate((selected) => {
        window.permissionPreview.requests.length = 0;
        window.permissionPreview.setRole(selected);
      }, role);
      await expect
        .poll(() => page.evaluate(() => window.permissionPreview.resourceState))
        .toEqual({
          rigs: role === "rigs" ? 1 : 0,
          machines: role === "machines" ? 1 : 0,
          blocked: false,
        });
      const calls = await page.evaluate(() =>
        window.permissionPreview.requests.map((item) => item.method),
      );
      expect(calls.includes("rigs")).toBe(role === "rigs");
      expect(calls.includes("authority:rig")).toBe(role === "rigs");
      expect(calls.includes("authority:connected_machine")).toBe(role === "machines");
      expect(calls.includes("review-groups")).toBe(false);
    }
    await expect(page.getByRole("link", { name: "Knowledge", exact: true })).toBeVisible();
    await expect(page.getByText("Release verification runbook", { exact: true })).toBeVisible();
    await page.evaluate(() => window.permissionPreview.setRole("failure"));
    await expect(page.getByRole("alert")).toContainText(
      "selected personal resource is unavailable",
    );
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.permissionPreview.resourceState?.blocked)).toBe(true);
    if (output)
      await page.screenshot({ path: `${output}/authorized-failure-${width}.png`, fullPage: true });
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    expect(await page.evaluate(() => window.permissionPreview.violations)).toEqual([]);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await page.close();
  }
  console.log(
    "PASS: production KnowledgePage/navigation/resource status; exact reader grants, manager review, rigs-only/machines-only, revocation, authorized failure/retry; desktop/mobile without overflow or page errors. Sample data only; no production API/model calls.",
  );
} finally {
  await browser.close();
}
