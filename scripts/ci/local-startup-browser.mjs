import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${process.env.OPENGENI_WEB_PORT}/`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByText("What should the agent do?", { exact: true }).waitFor({ timeout: 60_000 });
  if (errors.length) throw new Error(errors.join("\n"));
} finally {
  await browser.close();
}
