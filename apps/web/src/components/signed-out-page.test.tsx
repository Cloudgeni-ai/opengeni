import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ManagedAuthPanel } from "./managed-auth-panel";
import { SignedOutPage } from "./signed-out-page";

test("signed-out page presents the approved copy around the existing social/email form", () => {
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
  expect(html).toContain("Your AI workspace");
  expect(html).toContain("Open-source cloud agents");
  expect(html).toContain("Work on research, documents, and code.");
  expect(html).toContain("Choose your models and tools");
  expect(html).toContain("Schedule one-off or recurring tasks");
  expect(html).toContain("Your agents keep working, even when you close your laptop");
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
