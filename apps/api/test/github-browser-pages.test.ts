import { describe, expect, test } from "bun:test";
import {
  githubInstallationChooserHtml,
  githubSetupPendingHtml,
  githubSetupSuccessHtml,
  githubSuccessHtml,
} from "../src/routes/github-browser-pages";

const candidate = {
  installation: {
    installationId: 42,
    accountId: 501,
    accountLogin: "owner",
    accountType: "User",
    suspended: false,
  },
  authorityKind: "personal_owner" as const,
};

describe("API GitHub browser pages", () => {
  test("chooser uses separate GET forms so a preselected account cannot override new installation", () => {
    const html = githubInstallationChooserHtml(
      [candidate],
      "signed-state",
      "workspace-id",
      "https://api.opengeni.test",
    );
    const forms = [...html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)];
    expect(forms).toHaveLength(2);
    for (const form of forms) {
      expect(form[0]).toContain('method="get"');
      expect(form[0]).toContain(
        'action="https://api.opengeni.test/v1/workspaces/workspace-id/github/installations/select"',
      );
      expect(form[1]).toContain('name="state" value="signed-state"');
    }
    expect(forms[0]![1]).toContain('name="installation_id" value="42" required checked');
    expect(forms[0]![1]).not.toContain('value="new"');
    expect(forms[1]![1]).toContain('name="installation_id" value="new"');
    expect(forms[1]![1]).not.toContain('value="42"');
    expect(html).toContain('form="existing-account"');
    expect(html).toContain('aria-label="Available GitHub accounts"');
    expect(html).toContain(":focus-visible");
    expect(html).toContain("prefers-reduced-motion:reduce");
  });

  test("escapes owner display names, signed state, and form action attributes", () => {
    const html = githubInstallationChooserHtml(
      [
        {
          ...candidate,
          installation: { ...candidate.installation, accountLogin: '<img src=x onerror="go()">' },
        },
      ],
      'signed" onfocus="go()',
      "workspace-id",
      'https://api.opengeni.test/?q="attack',
    );
    expect(html).toContain("&lt;img src=x onerror=&quot;go()&quot;&gt;");
    expect(html).toContain('value="signed&quot; onfocus=&quot;go()"');
    expect(html).not.toContain('<img src=x onerror="go()">');
  });

  test("success and pending states retain exact outcome and escape user content", () => {
    const success = githubSetupSuccessHtml(
      '<script>alert("bad")</script>',
      'https://opengeni.test/?return="bad"&github=connected',
    );
    expect(success).toContain("GitHub connected");
    expect(success).toContain("&lt;script&gt;alert(&quot;bad&quot;)&lt;/script&gt;");
    expect(success).toContain(
      'href="https://opengeni.test/?return=&quot;bad&quot;&amp;github=connected"',
    );
    expect(success).not.toContain('<script>alert("bad")</script>');
    const pending = githubSetupPendingHtml();
    expect(pending).toContain("Waiting for an organization owner");
    expect(pending).toContain("has not created a workspace binding");
    expect(pending).not.toContain("GitHub connected");
  });

  test("operator setup still provides copyable, escaped environment values", () => {
    const html = githubSuccessHtml(['GITHUB_SECRET=<script>"&</script>']);
    expect(html).toContain('id="copy-env"');
    expect(html).toContain('id="env-lines"');
    expect(html).toContain("GITHUB_SECRET=&lt;script&gt;&quot;&amp;&lt;/script&gt;");
    expect(html).toContain("navigator.clipboard.writeText");
  });
});
