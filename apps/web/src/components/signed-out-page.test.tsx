import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ManagedAuthPanel } from "./managed-auth-panel";
import { SignedOutPage } from "./signed-out-page";

test("signed-out page speaks to everyday use first, developers second, around the existing form", () => {
  const html = renderToStaticMarkup(
    <SignedOutPage>
      <ManagedAuthPanel
        presentation="embedded"
        socialProviders={["google", "github"]}
        onSocialSubmit={async () => undefined}
        onSubmit={async () => undefined}
      />
    </SignedOutPage>,
  );
  expect(html).toContain("Get things done,");
  expect(html).toContain("just by asking.");
  expect(html).toContain(
    "Plan a trip, write a letter, make sense of a bill, or hand off a long task. Developers can build the same agents into their own apps.",
  );
  expect(html).toContain("Ask anything, on your computer or your phone");
  expect(html).toContain("Keeps working on long tasks, even when you close your laptop");
  expect(html).toContain(
    "For developers: tools, sandboxes, approvals and observability, ready to use",
  );
  expect(html).not.toContain("Infrastructure out of the box.");
  expect(html.match(/<li\b/g)).toHaveLength(3);
  expect(html.match(/<h1\b/g)).toHaveLength(1);
  expect(html).toContain('<h2 class="text-base font-semibold">Sign in</h2>');
  expect(html).toContain("Continue with Google");
  expect(html).toContain("Continue with GitHub");
  expect(html).toContain("managed-auth-email");
  expect(html).toContain("Forgot password?");
  expect(html).toContain("Appearance");
  expect(html).toContain("min-h-0 flex-1 overflow-y-auto");
  expect(html).not.toContain("max-w-sm");
});

test("the Excel pitch speaks to Excel users and keeps the same form and links", () => {
  const html = renderToStaticMarkup(
    <SignedOutPage pitch="excel" supportEmail="support@opengeni.ai">
      <ManagedAuthPanel
        presentation="embedded"
        socialProviders={["google", "github"]}
        onSocialSubmit={async () => undefined}
        onSubmit={async () => undefined}
      />
    </SignedOutPage>,
  );
  expect(html).toContain("Your Opengeni agents,");
  expect(html).toContain("right inside Excel.");
  expect(html).toContain(
    "Sign in to connect the add-in. Then ask in plain words and watch the agent work in your open workbook.",
  );
  expect(html).toContain("Builds tables, formulas and summaries in your sheets");
  expect(html).toContain("Cleans up messy data and formats sheets");
  expect(html).toContain("Explains what is in a workbook");
  expect(html).not.toContain("Get things done,");
  expect(html).not.toContain("just by asking.");
  expect(html.match(/<li\b/g)).toHaveLength(3);
  expect(html.match(/<h1\b/g)).toHaveLength(1);
  expect(html).toContain("Continue with Google");
  expect(html).toContain("Contact support");
});

test("legal links render only when the deployment configures them", () => {
  const unconfigured = renderToStaticMarkup(
    <SignedOutPage>
      <ManagedAuthPanel presentation="embedded" onSubmit={async () => undefined} />
    </SignedOutPage>,
  );
  expect(unconfigured).not.toContain('aria-label="Legal and support"');
  expect(unconfigured).not.toContain(">Privacy<");
  expect(unconfigured).not.toContain(">Terms<");
  expect(unconfigured).not.toContain("Contact support");

  const configured = renderToStaticMarkup(
    <SignedOutPage
      legalLinks={{
        privacyPolicyUrl: "https://opengeni.ai/privacy",
        termsOfServiceUrl: "https://opengeni.ai/terms",
      }}
      supportEmail="support@opengeni.ai"
    >
      <ManagedAuthPanel presentation="embedded" onSubmit={async () => undefined} />
    </SignedOutPage>,
  );
  expect(configured).toContain('aria-label="Legal and support"');
  expect(configured).toMatch(/<a href="https:\/\/opengeni\.ai\/privacy"[^>]*>Privacy<\/a>/);
  expect(configured).toMatch(/<a href="https:\/\/opengeni\.ai\/terms"[^>]*>Terms<\/a>/);
  expect(configured).toContain('rel="noopener noreferrer"');
  // A mailto link opens the mail client in place, not a blank tab.
  expect(configured).toMatch(
    /<a href="mailto:support@opengeni\.ai" class="[^"]*">Contact support<\/a>/,
  );

  const privacyOnly = renderToStaticMarkup(
    <SignedOutPage legalLinks={{ privacyPolicyUrl: "https://example.test/privacy" }}>
      <ManagedAuthPanel presentation="embedded" onSubmit={async () => undefined} />
    </SignedOutPage>,
  );
  expect(privacyOnly).toContain(">Privacy<");
  expect(privacyOnly).not.toContain(">Terms<");
  expect(privacyOnly).not.toContain("Contact support");
});

test("provider configuration and invitation precedence remain owned by the form", () => {
  const unconfigured = renderToStaticMarkup(
    <SignedOutPage>
      <ManagedAuthPanel presentation="embedded" onSubmit={async () => undefined} />
    </SignedOutPage>,
  );
  expect(unconfigured).not.toContain("Continue with Google");
  const invited = renderToStaticMarkup(
    <SignedOutPage>
      <ManagedAuthPanel
        presentation="embedded"
        invitation={{ organizationName: "Example team", targetEmail: "invitee@example.test" }}
        socialProviders={["google", "github"]}
        onSocialSubmit={async () => undefined}
        onSubmit={async () => undefined}
      />
    </SignedOutPage>,
  );
  expect(invited).toContain("invitee@example.test");
  expect(invited).toContain("Example team");
  expect(invited).not.toContain("Continue with Google");
  expect(invited).not.toContain("Continue with GitHub");
});
