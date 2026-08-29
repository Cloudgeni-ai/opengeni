import { useState } from "react";
import { createRoot } from "react-dom/client";

import { PersonalGitHubDialog } from "../src/components/capabilities/personal-github-dialog";
import { Button } from "../src/components/ui/button";
import type {
  PersonalGitHubRepositoryCatalogItem,
  PersonalGitHubRepositorySelectionInput,
} from "@opengeni/sdk";
import "../src/styles.css";

function repository(
  repositoryId: string,
  fullName: string,
  overrides: Partial<PersonalGitHubRepositoryCatalogItem> = {},
): PersonalGitHubRepositoryCatalogItem {
  return {
    repositoryId,
    fullName,
    canonicalUrl: `https://github.com/${fullName}`,
    defaultBranch: "main",
    visibility: "private",
    private: true,
    archived: false,
    disabled: false,
    permissions: { pull: true, push: true, admin: false, maintain: false, triage: false },
    selectedAccess: null,
    ...overrides,
  };
}

const repositories = [
  repository("101", "octocat/opengeni", { selectedAccess: "write" }),
  repository("102", "octocat/design-system", {
    visibility: "public",
    private: false,
    selectedAccess: "read",
    permissions: { pull: true, push: false, admin: false, maintain: false, triage: true },
  }),
  repository("103", "octocat/research-notes", {
    permissions: { pull: true, push: false, admin: false, maintain: true, triage: false },
  }),
  repository("104", "octocat/archived-project", { archived: true, disabled: true }),
];

function Fixture() {
  const [open, setOpen] = useState(true);
  const [receipt, setReceipt] = useState<Record<string, unknown>>({});

  return (
    <main className="min-h-screen bg-canvas p-6">
      <Button type="button" onClick={() => setOpen(true)}>
        Manage GitHub identity
      </Button>
      <output data-testid="personal-github-receipt" className="sr-only">
        {JSON.stringify(receipt)}
      </output>
      <PersonalGitHubDialog
        open={open}
        onOpenChange={setOpen}
        login="octocat"
        repositories={repositories}
        busy={false}
        onSave={async (selection: PersonalGitHubRepositorySelectionInput[]) => {
          setReceipt({ action: "save", selection });
          return true;
        }}
        onReconnect={() => setReceipt({ action: "reconnect" })}
        onDisconnect={() => setReceipt({ action: "disconnect" })}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
