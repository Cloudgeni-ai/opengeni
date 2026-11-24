// FormPage footers as the app draws them, for form-page-footer.browser.e2e.ts.
// `?view=consent` (default): the agent sign-in page ("Connect Claude Code to
// Opengeni") in its ConsentFrame, as /connect-agent renders it.
// `?view=content`: a long FormPage in a ContentPage, as workspace routes render it.
// The theme follows the browser's color scheme.
import { createRoot } from "react-dom/client";
import { AppearanceProvider } from "@opengeni/react/app/lib/appearance";
import { ContentPage } from "@opengeni/react/ui/content-layout";
import { Field, FieldStack } from "@opengeni/react/ui/field";
import { FormPage } from "@opengeni/react/ui/form-dialog";
import { McpConsentPage } from "../src/components/organization-access/mcp-consent-page";
import { allOrganizationPermissions } from "../src/lib/organization-access";
import "../src/styles.css";

const view = new URLSearchParams(location.search).get("view") ?? "consent";

const workspaces = [
  { id: "w-personal", name: "Personal", personal: true },
  { id: "w-platform", name: "Platform", personal: false },
  { id: "w-research", name: "Research", personal: false },
];
const grantable = allOrganizationPermissions().filter(
  (permission) => !permission.startsWith("account:") && !permission.startsWith("billing:"),
);

function Consent() {
  return (
    <McpConsentPage
      request={{
        client: { name: "Claude Code", host: "localhost" },
        person: { name: "Example Person" },
        defaultOrganizationId: "org-1",
        organizations: [
          { id: "org-1", name: "Example", workspaces, grantable },
          { id: "org-2", name: "Personal", workspaces: workspaces.slice(0, 1), grantable },
        ],
      }}
      onAnswer={async () => {}}
    />
  );
}

function Content() {
  return (
    <ContentPage>
      <FormPage title="New automation" submitLabel="Create" onCancel={() => {}} onSubmit={() => {}}>
        <FieldStack>
          {Array.from({ length: 24 }, (_, index) => (
            <Field key={index} label={`Field ${index + 1}`}>
              <input className="h-9 w-full rounded-md border border-border bg-surface px-3" />
            </Field>
          ))}
        </FieldStack>
      </FormPage>
    </ContentPage>
  );
}

createRoot(document.getElementById("root")!).render(
  <AppearanceProvider>
    <div className="flex h-dvh flex-col bg-bg text-fg">
      {view === "content" ? <Content /> : <Consent />}
    </div>
  </AppearanceProvider>,
);
