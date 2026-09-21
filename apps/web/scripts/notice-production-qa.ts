import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseSync } from "oxc-parser";
import { chromium } from "playwright";
import { OPENGENI_API_CONTRACT_REVISION } from "@opengeni/contracts";
import { createWebHandler } from "../src/server";

// Run after the normal web production build. Do not build Notice as a separate
// entry: that would change the chunk graph and miss the initialization cycle.
const dist = resolve(import.meta.dir, "../dist");
const output = process.env.OPENGENI_NOTICE_QA_OUTPUT ?? "/workspace/notice-production-qa";
const manifest = JSON.parse(await readFile(resolve(dist, ".vite/manifest.json"), "utf8")) as Record<
  string,
  { file: string }
>;
type AstNode = { type?: string; [key: string]: unknown };
function node(value: unknown): AstNode | null {
  return value !== null && typeof value === "object" ? (value as AstNode) : null;
}
function name(value: unknown): string | undefined {
  const valueNode = node(value);
  return typeof valueNode?.name === "string" ? valueNode.name : undefined;
}
async function findBuiltNotice(): Promise<{ path: string; exportName: string }> {
  const matches: Array<{ path: string; exportName: string }> = [];
  for (const file of new Set(Object.values(manifest).map((entry) => entry.file))) {
    if (!file.endsWith(".js")) continue;
    const source = await readFile(resolve(dist, file), "utf8");
    if (!source.includes("border-status-idle/30 bg-status-idle/[0.06]")) continue;
    const program = parseSync(file, source, { sourceType: "module" }).program;
    for (const statement of program.body) {
      if (statement.type !== "FunctionDeclaration") continue;
      const first = node(statement.params[0]);
      if (first?.type !== "ObjectPattern" || !Array.isArray(first.properties)) continue;
      const keys = first.properties.map((property) => name(node(property)?.key));
      if (
        !["tone", "title", "children", "action", "icon", "className"].every((key) =>
          keys.includes(key),
        )
      )
        continue;
      const localName = statement.id?.name;
      for (const exported of program.body) {
        if (exported.type !== "ExportNamedDeclaration") continue;
        for (const specifier of exported.specifiers) {
          if (name(specifier.local) === localName) {
            const exportedName = name(specifier.exported);
            if (exportedName) matches.push({ path: `/${file}`, exportName: exportedName });
          }
        }
      }
    }
  }
  if (matches.length !== 1)
    throw new Error(`Expected one exported production Notice; found ${matches.length}`);
  return matches[0]!;
}
const builtNotice = await findBuiltNotice();
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createWebHandler(dist) });
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const browserErrors: string[] = [];
const calls: string[] = [];
page.on("pageerror", (error) => browserErrors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") browserErrors.push(message.text());
});
const email = "signup-diagnosis@example.test";
try {
  await page.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    calls.push(`${route.request().method()} ${path}`);
    let status = 200;
    let body: unknown;
    if (path === "/v1/config/client")
      body = {
        deploymentRevision: "notice-production-qa",
        apiContractRevision: OPENGENI_API_CONTRACT_REVISION,
        defaultModel: "qa",
        allowedModels: ["qa"],
        models: [],
        defaultReasoningEffort: "low",
        allowedReasoningEfforts: ["low"],
        mcpServers: [],
        fileUploads: { enabled: false, maxSizeBytes: 1048576 },
        productAccessMode: "managed",
        auth: {
          mode: "managedSession",
          session: "cookie",
          emailVerificationRequired: true,
          socialProviders: [],
        },
        managedAuthSessionSetMode: "legacy",
        structuredServices: { fileSystem: false, git: false, terminalEvents: false },
      };
    else if (path === "/v1/auth/get-session") body = null;
    else if (path === "/v1/auth/sign-up/email")
      body = {
        token: null,
        user: { id: "signup-test", name: "Onboarding Owner", email, emailVerified: false },
      };
    else {
      status = 403;
      body = { error: { code: "forbidden", message: "No workspace fixture" } };
    }
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto(`http://127.0.0.1:${server.port}/`);
  await page.getByRole("button", { name: "Sign up", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Onboarding Owner");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill("Onboarding-password-1234");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await page.getByText(`We sent a verification link to ${email}.`).waitFor({ timeout: 5000 });
  const tones = await page.evaluate(async ({ path, exportName }) => {
    const built = await import(path);
    const notice = built[exportName];
    return ["muted", "info", "success", "waiting", "failed"].map((tone) => {
      const tree = notice({ tone, title: `Production ${tone}`, children: "Notice body" });
      const glyph = tree.props.children[0].props.children;
      return { tone, glyphType: typeof glyph.type, className: tree.props.className };
    });
  }, builtNotice);
  for (const result of tones) {
    if (!["object", "function"].includes(result.glyphType))
      throw new Error(`Production ${result.tone} Notice has an invalid glyph: ${result.glyphType}`);
  }
  if (browserErrors.length)
    throw new Error(`Production browser errors: ${browserErrors.join("; ")}`);
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: resolve(output, "signup-success.png"), fullPage: true });
  console.log(
    JSON.stringify({
      passed: true,
      builtNotice,
      tones,
      calls,
      browserErrors,
      screenshot: resolve(output, "signup-success.png"),
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      passed: false,
      browserErrors,
      calls,
      body: await page.locator("body").innerText(),
    }),
  );
  throw error;
} finally {
  await browser.close();
  server.stop(true);
}
