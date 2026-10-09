import { chromium } from "playwright";
import { createRequire } from "node:module";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect } from "bun:test";

const require = createRequire(new URL("../../artifact-tool/package.json", import.meta.url));
const ExcelJS = require("exceljs");
const output = resolve(
  process.env.SPREADSHEET_PREVIEW_OUTPUT ?? "/workspace/spreadsheet-download-evidence",
);
await mkdir(output, { recursive: true });
// A genuine XLSX fixture, not a renamed CSV or a production export claim.
const workbook = new ExcelJS.Workbook();
const sheet = workbook.addWorksheet("Forecast");
sheet.addRow(["Period", "Revenue", "Expenses", "Net income", "Region", "Forecast"]);
sheet.addRow(["Period 1", 120127, null, 43019]);
const xlsx = await workbook.xlsx.writeBuffer();
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({
  viewport: { width: 1280, height: 800 },
  acceptDownloads: true,
});
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/sample.xlsx", (route) =>
  route.fulfill({
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    body: Buffer.from(xlsx),
  }),
);
async function open(suffix = "") {
  await page.goto(`http://127.0.0.1:4328/artifact-spreadsheet-test.html${suffix}`);
  await page.evaluate(async () => {
    const fixturePath = "/artifact-spreadsheet-download-fixture.tsx";
    await import(fixturePath);
  });
  await page.getByRole("button", { name: "Download", exact: true }).waitFor();
  await page.getByRole("gridcell", { name: "A1, Period", exact: true }).waitFor();
}
try {
  await open();
  await page.screenshot({ path: `${output}/desktop.png` });
  const formula = page.getByRole("textbox", { name: "Formula or value", exact: true });
  await formula.fill("Edited period");
  await page.evaluate(() => {
    (document.activeElement as HTMLElement).blur();
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent === "Download")!
      .click();
  });
  expect(await page.getByRole("button", { name: "Download", exact: true }).isDisabled()).toBe(true);
  expect(await page.evaluate(() => (window as any).downloadFixture.calls.length)).toBe(0);
  await page.screenshot({ path: `${output}/submitting.png` });
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll("button")].find((button) => button.textContent === "Download")
        ?.disabled,
  );
  await page.evaluate(() => (window as any).downloadFixture.setPending(1));
  await page.waitForFunction(
    () =>
      (
        document.querySelector(
          'button[title="Wait for workbook changes to sync"]',
        ) as HTMLButtonElement
      )?.disabled,
  );
  await page.evaluate(() => (window as any).downloadFixture.setPending(0));
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await page.getByRole("button", { name: "Preparing…" }).waitFor();
  await page.screenshot({ path: `${output}/preparing.png` });
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe("Forecast workbook.xlsx");
  const file = `${output}/Forecast workbook.xlsx`;
  await download.saveAs(file);
  expect(Buffer.from(await readFile(file)).equals(Buffer.from(xlsx))).toBe(true);
  const reimport = new ExcelJS.Workbook();
  await reimport.xlsx.readFile(file);
  expect(reimport.worksheets[0].name).toBe("Forecast");
  expect(reimport.worksheets[0].getCell("B2").value).toBe(120127);
  await page.evaluate(() => (window as any).downloadFixture.fail());
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await page.getByRole("alert").waitFor();
  await page.screenshot({ path: `${output}/error.png` });
  const retry = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await retry;
  await open("?embedded");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${output}/embedded-mobile.png` });
  expect(await page.getByRole("button", { name: "Download", exact: true }).isVisible()).toBe(true);
  expect(errors).toEqual([]);
  console.log(
    JSON.stringify({
      result: "passed",
      filename: download.suggestedFilename(),
      bytes: xlsx.byteLength,
      sha256: new Bun.CryptoHasher("sha256").update(xlsx).digest("hex"),
      sheet: "Forecast",
      B2: 120127,
      errors,
      output,
    }),
  );
} finally {
  await browser.close();
}
