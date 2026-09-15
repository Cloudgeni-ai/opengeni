import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { OPENGENI_API_CONTRACT_REVISION } from "@opengeni/contracts";

// Run against the web dev server. This verifies actual production components
// with explicitly simulated provider outcomes; it does not exercise OAuth.
const base = process.env.OPENGENI_VISUAL_QA_URL ?? "http://127.0.0.1:3000";
const output = process.env.OPENGENI_VISUAL_QA_OUTPUT ?? "/workspace/sign-in-methods-qa";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
try {
  await page.goto(`${base}/dev/onboarding?view=security`);
  await page.getByRole("heading", { name: "Security", exact: true }).waitFor();
  assert(
    await page.getByRole("button", { name: "Disconnect Google" }).isDisabled(),
    "Last method must be protected",
  );
  await page.screenshot({ path: `${output}/desktop.png`, fullPage: true });
  await page.getByRole("button", { name: "Reconnect GitHub" }).click();
  await page.getByRole("status").filter({ hasText: "sign-in method connected" }).waitFor();
  await page.getByRole("button", { name: "Disconnect GitHub" }).click();
  await page.getByRole("dialog").waitFor();
  assert(
    await page
      .getByRole("button", { name: "Cancel", exact: true })
      .evaluate((node) => node === document.activeElement),
    "Disconnect must focus the safe action",
  );
  await page.screenshot({ path: `${output}/disconnect.png`, fullPage: true });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Set password" }).click();
  await page.getByLabel("New password", { exact: true }).fill("preview-new-password");
  await page.getByLabel("Confirm new password", { exact: true }).fill("preview-other-password");
  await page.getByRole("button", { name: "Save password" }).click();
  await page.getByRole("alert").filter({ hasText: "passwords don't match" }).waitFor();
  await page.screenshot({ path: `${output}/password-validation.png`, fullPage: true });
  await page.getByLabel("Confirm new password", { exact: true }).fill("preview-new-password");
  await page.getByRole("button", { name: "Save password" }).click();
  await page.getByRole("button", { name: "Change password" }).waitFor();
  await page.goto(`${base}/dev/onboarding?view=security&state=reauth`);
  await page.getByRole("button", { name: "Sign in again" }).waitFor();
  assert(
    await page.getByRole("button", { name: "Reconnect GitHub" }).isDisabled(),
    "Stale authentication must lock changes",
  );
  await page.screenshot({ path: `${output}/reauth.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${output}/mobile.png`, fullPage: true });
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "Narrow screen must not overflow horizontally",
  );
  await page.getByRole("button", { name: "Open personal settings menu" }).click();
  await page.getByRole("dialog").waitFor();
  await page.screenshot({ path: `${output}/mobile-menu.png`, fullPage: true });
  for (const mode of ["legacy", "broker"] as const) {
    const isolated = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const routePage = await isolated.newPage();
    routePage.on("pageerror", (error) => errors.push(error.message));
    await routePage.route("**/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      let body: unknown;
      let status = 200;
      if (path === "/v1/config/client")
        body = {
          deploymentRevision: "security-visual-qa",
          apiContractRevision: OPENGENI_API_CONTRACT_REVISION,
          defaultModel: "qa-model",
          allowedModels: ["qa-model"],
          models: [],
          defaultReasoningEffort: "low",
          allowedReasoningEfforts: ["low"],
          mcpServers: [],
          fileUploads: { enabled: false, maxSizeBytes: 1048576 },
          productAccessMode: "managed",
          auth: {
            mode: "managedSession",
            session: "cookie",
            socialProviders: ["google", "github"],
          },
          managedAuthSessionSetMode: mode,
          structuredServices: { fileSystem: false, git: false, terminalEvents: false },
        };
      else if (path === "/v1/auth/get-session")
        body = {
          session: { id: "qa-session", userId: "qa-human", expiresAt: "2030-01-01T00:00:00Z" },
          user: {
            id: "qa-human",
            name: "QA Human",
            email: "no-memberships@example.com",
            emailVerified: true,
          },
        };
      else if (path === "/v1/auth/session-set")
        body = {
          mode: "broker",
          generation: "1",
          actorEpoch: "1",
          csrfToken: "c".repeat(43),
          selectedSlotId: "00000000-0000-4000-8000-000000000001",
          state: "ready",
          slots: [
            {
              id: "00000000-0000-4000-8000-000000000001",
              displayName: "QA Human",
              verifiedClaim: { kind: "email", value: "no-memberships@example.com" },
              state: "active",
            },
          ],
        };
      else if (path === "/v1/auth/sign-in-methods")
        body = {
          email: "no-memberships@example.com",
          emailVerified: true,
          identityRevision: 1,
          freshAuthenticationRequired: false,
          methods: [
            {
              provider: "credential",
              connected: true,
              available: true,
              canDisconnect: false,
              implicitRelinkingSuppressed: false,
            },
          ],
        };
      else {
        status = 403;
        body = { error: { code: "forbidden", message: "No workspace membership in this fixture" } };
      }
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    });
    await routePage.goto(`${base}/settings/security`);
    await routePage.getByRole("heading", { name: "Security", exact: true }).waitFor();
    await routePage.getByRole("button", { name: "Change password" }).waitFor();
    await routePage.screenshot({ path: `${output}/no-workspace-${mode}.png`, fullPage: true });
    await isolated.close();
  }
  assert(errors.length === 0, `Browser errors: ${errors.join("; ")}`);
  console.log(JSON.stringify({ passed: true, output, screenshots: 8, errors }));
} finally {
  await browser.close();
}
