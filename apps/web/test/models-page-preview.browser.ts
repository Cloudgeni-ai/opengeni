import { mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright";

// Organization settings > Models with the organization's own OpenAI and Azure
// OpenAI keys, rendered with the real page against a synthetic client.
const base = process.env.OPENGENI_MODELS_PREVIEW_URL ?? "http://127.0.0.1:4197";
const output = process.env.OPENGENI_MODELS_PREVIEW_OUTPUT ?? "/tmp/opengeni-models-preview";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const assert = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};
const receipts = async (page: Page) =>
  JSON.stringify(
    await page.evaluate(() => (window as unknown as { modelsReceipts: unknown[] }).modelsReceipts),
  );

try {
  for (const width of [1100, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const open = async (query: string) =>
      await page.goto(
        `${base}/test/fixtures/models-page-preview/?${query}&theme=${width === 390 ? "dark" : "light"}`,
        { waitUntil: "networkidle" },
      );
    const shot = (name: string) =>
      page.screenshot({ path: `${output}/${name}-${width}.png`, fullPage: true });
    const noOverflow = async () =>
      assert(
        !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)),
        "horizontal overflow",
      );

    // Connect provider offers both organization keys.
    await open("view=connect");
    await page.getByText("OpenAI API", { exact: true }).first().waitFor();
    await page.getByText("Azure OpenAI", { exact: true }).first().waitFor();
    await noOverflow();
    await shot("connect");

    // OpenAI, not connected: a key field; models come after connecting.
    await page.getByText("OpenAI API", { exact: true }).first().click();
    const key = page.getByLabel("Organization OpenAI API key");
    await key.waitFor();
    assert((await key.getAttribute("type")) === "password", "the key field is masked");
    await noOverflow();
    await shot("openai-connect");
    await key.fill("sk-preview");
    await page.getByRole("button", { name: "Connect OpenAI" }).click();
    await page.getByText("Enter the exact model ID", { exact: false }).first().waitFor();
    assert((await receipts(page)).includes('"upsert":"openai"'), "saved the OpenAI key");
    assert(!(await page.content()).includes("sk-preview"), "the key is never shown");
    await noOverflow();
    await shot("openai-connected");

    // Connected: a model is added by its exact ID.
    const model = page.getByLabel("OpenAI model ID").or(page.getByLabel("OpenAI model")).first();
    await model.fill("gpt-6.1-sol");
    await page.getByRole("button", { name: /^Add model$/ }).click();
    await page.getByText("gpt-6.1-sol", { exact: true }).first().waitFor();
    assert((await receipts(page)).includes('"addModel":"openai"'), "added the OpenAI model");
    await shot("openai-model");

    // Azure, connected: the endpoint shows; the key never does.
    await open("account=org:gateway:azure_openai&azure=1");
    await page.getByText("https://acme.openai.azure.com/openai/v1").first().waitFor();
    await page.getByLabel("Azure OpenAI deployment name").waitFor();
    await noOverflow();
    await shot("azure-connected");

    // The organization's list shows both once connected.
    await open("openai=1&azure=1");
    await page.getByText("OpenAI API", { exact: true }).first().waitFor();
    await page.getByText("Azure OpenAI", { exact: true }).first().waitFor();
    await noOverflow();
    await shot("list");

    assert(errors.length === 0, `page errors: ${errors.join("; ")}`);
    await page.close();
  }
  console.log(`[models-preview] ok; screenshots in ${output}`);
} finally {
  await browser.close();
}
