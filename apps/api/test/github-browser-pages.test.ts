import { describe, expect, test } from "bun:test";
import {
  githubConnectFailureHtml,
  githubInstallationChooserHtml,
  githubSetupPendingHtml,
  githubOwnerApprovedHtml,
  githubSetupSuccessHtml,
  githubSuccessHtml,
  prReviewInstallationChooserHtml,
  prReviewSetupPendingHtml,
  prReviewSetupSuccessHtml,
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
    // A non-owner learns how to ask their organization owners before GitHub.
    expect(html).toContain("Not an owner of your GitHub organization?");
    expect(html).toContain("send its owners a request to approve");
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
    const pending = githubSetupPendingHtml('https://opengeni.test/?return="bad"&github=requested');
    expect(pending).toContain("Request sent to your organization owners");
    expect(pending).toContain("Nothing is connected until an owner finishes");
    expect(pending).toContain(
      'href="https://opengeni.test/?return=&quot;bad&quot;&amp;github=requested"',
    );
    expect(pending).not.toContain("GitHub connected");
    expect(githubSetupPendingHtml()).not.toContain("Back to Opengeni");
    const approved = githubOwnerApprovedHtml('https://opengeni.test/?x="bad"');
    expect(approved).toContain("Opengeni is installed on GitHub");
    expect(approved).toContain('href="https://opengeni.test/?x=&quot;bad&quot;"');
    expect(approved).toContain("doesn't give any Opengeni workspace access");
  });

  test("operator setup still provides copyable, escaped environment values", () => {
    const html = githubSuccessHtml(['GITHUB_SECRET=<script>"&</script>']);
    expect(html).toContain('id="copy-env"');
    expect(html).toContain('id="env-lines"');
    expect(html).toContain("GITHUB_SECRET=&lt;script&gt;&quot;&amp;&lt;/script&gt;");
    expect(html).toContain("navigator.clipboard.writeText");
  });

  test("pages stay self-contained, inline the app fonts and follow the system color scheme", () => {
    for (const html of [
      githubInstallationChooserHtml(
        [candidate],
        "state",
        "workspace-id",
        "https://api.opengeni.test",
      ),
      githubSetupSuccessHtml("owner", "https://opengeni.test/"),
      githubSetupPendingHtml("https://opengeni.test/"),
      githubOwnerApprovedHtml("https://opengeni.test/"),
      githubConnectFailureHtml("expired", "https://opengeni.test/"),
      githubSuccessHtml(["OPENGENI_GITHUB_APP_ID=1"]),
      prReviewInstallationChooserHtml([candidate], "state", "https://api.opengeni.test/select"),
      prReviewSetupSuccessHtml("owner", "https://opengeni.test/"),
      prReviewSetupPendingHtml(),
    ]) {
      expect(html).toContain("prefers-color-scheme:light");
      expect(html).toContain('class="wordmark">Opengeni<');
      expect(html).not.toMatch(/<link\b|\bsrc="|@import|url\((?!data:font\/woff2;base64,)/);
      expect(html).toContain('@font-face{font-family:"Inter Variable"');
      expect(html).toContain('@font-face{font-family:"DM Sans Variable"');
    }
  });

  test("every page shows the GitHub mark next to the Opengeni mark, in both themes", () => {
    for (const html of [
      githubInstallationChooserHtml(
        [candidate],
        "state",
        "workspace-id",
        "https://api.opengeni.test",
      ),
      githubSetupSuccessHtml("owner", "https://opengeni.test/"),
      githubSetupPendingHtml(),
      githubOwnerApprovedHtml("https://opengeni.test/"),
      ...(
        [
          "expired",
          "cancelled",
          "not_owner",
          "forbidden",
          "policy_denied",
          "signed_out",
          "failed",
        ] as const
      ).map((failure) => githubConnectFailureHtml(failure, "https://opengeni.test/")),
      githubSuccessHtml(["OPENGENI_GITHUB_APP_ID=1"]),
      prReviewInstallationChooserHtml([candidate], "state", "https://api.opengeni.test/select"),
      prReviewSetupSuccessHtml("owner", "https://opengeni.test/"),
      prReviewSetupPendingHtml(),
    ]) {
      const lockup = html.match(
        /<div class="lockup" role="img" aria-label="Opengeni and GitHub">([\s\S]*?)<\/div>/,
      );
      expect(lockup).not.toBeNull();
      expect(lockup![1]).toContain('class="opengeni-mark"');
      // The Octocat path, filled with the text color so it flips with the theme.
      expect(lockup![1]).toMatch(
        /<svg class="github-mark" viewBox="0 0 24 24" fill="currentColor"[^>]*><path d="M 12 \.7a11\.5/,
      );
      expect(html).toMatch(/\.lockup-tile\{[^}]*color:var\(--fg\)/);
    }
  });

  test("Opengeni Lens pages keep their forms and escape user content", () => {
    const chooser = prReviewInstallationChooserHtml(
      [
        {
          ...candidate,
          installation: { ...candidate.installation, accountLogin: "<b>x</b>" },
        },
      ],
      'signed" x="y',
      'https://api.opengeni.test/select?a="b',
    );
    expect(chooser).toContain('action="https://api.opengeni.test/select?a=&quot;b"');
    expect(chooser).toContain('name="state" value="signed&quot; x=&quot;y"');
    expect(chooser).toContain('name="installation_id" value="42" required');
    expect(chooser).toContain('name="installation_id" value="new" formnovalidate');
    expect(chooser).toContain("&lt;b&gt;x&lt;/b&gt;");
    const success = prReviewSetupSuccessHtml("<i>org</i>", 'https://opengeni.test/?r="x"');
    expect(success).toContain("Opengeni Lens connected");
    expect(success).toContain("&lt;i&gt;org&lt;/i&gt;");
    expect(success).toContain('href="https://opengeni.test/?r=&quot;x&quot;"');
    expect(prReviewSetupPendingHtml()).toContain(
      "A GitHub organization owner must approve Opengeni Lens",
    );
  });
});
