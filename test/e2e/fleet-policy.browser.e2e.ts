import AxeBuilder from "@axe-core/playwright";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { chromium, type Browser } from "playwright";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import { createFleetPolicyCanonicalProof } from "../../packages/react/demo/fleet-policy-canonical-proof";

const repoRoot = new URL("../..", import.meta.url).pathname;
const evidenceDirectory = "/tmp/ope32-browser-evidence";

describe("OPE-32 fleet policy browser acceptance", () => {
  let browser: Browser;
  let demo: StartedProcess;
  let baseUrl: string;

  beforeAll(async () => {
    await mkdir(evidenceDirectory, { recursive: true });
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    try {
      browser = await chromium.launch();
      demo = await startProcess(
        [
          "bun",
          "run",
          "vite",
          "dev",
          "demo",
          "--host",
          "127.0.0.1",
          "--port",
          String(port),
          "--strictPort",
          "--force",
        ],
        {
          cwd: `${repoRoot}/packages/react`,
          ready: async () =>
            (
              await fetch(`${baseUrl}/fleet-policy.html`, {
                signal: AbortSignal.timeout(2_000),
              }).catch(() => null)
            )?.ok === true,
          timeoutMs: 45_000,
        },
      );
    } catch (error) {
      await demo?.stop().catch(() => undefined);
      await browser?.close().catch(() => undefined);
      throw error;
    }
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([demo?.stop(), browser?.close()]);
  }, 60_000);

  test("desktop and mobile remain bounded, keyboard-operable, secret-safe, and WCAG AA clean", async () => {
    const cases = [
      {
        name: "desktop",
        width: 1440,
        height: 900,
        mobile: false,
        theme: "dark",
      },
      { name: "mobile", width: 320, height: 740, mobile: true, theme: "light" },
    ] as const;
    const failures: unknown[] = [];
    const bunCanonicalProof = createFleetPolicyCanonicalProof();

    for (const fixture of cases) {
      const context = await browser.newContext({
        viewport: { width: fixture.width, height: fixture.height },
        isMobile: fixture.mobile,
        hasTouch: fixture.mobile,
      });
      const page = await context.newPage();
      const runtimeProblems: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "warning" || message.type() === "error") {
          runtimeProblems.push(`console:${message.text()}`);
        }
      });
      page.on("pageerror", (error) => runtimeProblems.push(`page:${String(error)}`));
      page.on("requestfailed", (request) => runtimeProblems.push(`request:${request.url()}`));

      const response = await page.goto(`${baseUrl}/fleet-policy.html?theme=${fixture.theme}`, {
        waitUntil: "networkidle",
      });
      await page.locator('html[data-ope32-canonical-proof-ready="true"]').waitFor();
      const browserCanonicalProof = await page.evaluate(
        () =>
          (
            window as Window & {
              __OPE32_CANONICAL_PROOF__?: ReturnType<typeof createFleetPolicyCanonicalProof>;
            }
          ).__OPE32_CANONICAL_PROOF__,
      );
      expect(browserCanonicalProof).toEqual(bunCanonicalProof);
      expect(browserCanonicalProof).toMatchObject({
        candidateKeys: ["A", "a", "a-", "aa"],
        selectedCandidateKey: "aa",
        truncatedCandidateCount: 4,
      });
      const disclosure = page.getByRole("button", {
        name: /Fleet policy shadow/,
      });
      await disclosure.waitFor();
      expect(await disclosure.getAttribute("aria-expanded")).toBe("false");

      await disclosure.focus();
      expect(await disclosure.evaluate((element) => element === document.activeElement)).toBe(true);
      await page.keyboard.press("Enter");
      expect(await disclosure.getAttribute("aria-expanded")).toBe("true");
      await page.getByRole("region", { name: "Fleet policy shadow details" }).waitFor();

      const pageAudit = await page.evaluate(() => {
        const bodyText = document.body.innerText;
        const root = document.documentElement;
        const expandedDisclosure = document.querySelector('[role="button"][aria-expanded="true"]');
        const bounds = expandedDisclosure?.getBoundingClientRect();
        return {
          horizontalOverflow: root.scrollWidth - root.clientWidth,
          disclosureRight: bounds?.right ?? null,
          containsEmail: /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(bodyText),
          containsSecretTerm: /credential|fingerprint|access[ -]?token|refresh[ -]?token/i.test(
            bodyText,
          ),
        };
      });
      const axe = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();

      if (
        response?.status() !== 200 ||
        runtimeProblems.length > 0 ||
        pageAudit.horizontalOverflow !== 0 ||
        pageAudit.disclosureRight === null ||
        pageAudit.disclosureRight > fixture.width + 0.5 ||
        pageAudit.containsEmail ||
        pageAudit.containsSecretTerm ||
        axe.violations.length > 0
      ) {
        failures.push({
          fixture,
          status: response?.status(),
          runtimeProblems,
          pageAudit,
          axeViolations: axe.violations.map((rule) => ({
            id: rule.id,
            impact: rule.impact,
            nodes: rule.nodes.length,
          })),
        });
      }

      await page.screenshot({
        path: `${evidenceDirectory}/fleet-policy-${fixture.name}-${fixture.theme}.png`,
        fullPage: true,
      });
      await context.close();
    }

    expect(failures).toEqual([]);
  }, 60_000);
});
