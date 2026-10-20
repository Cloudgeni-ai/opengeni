import { useState, useSyncExternalStore } from "react";
import { useCodexSubscriptions } from "@/components/codex-connection";
import { useOrganizationCodexSubscriptions } from "@/components/organization-codex-subscriptions";
import { ACCOUNT_COLUMNS, CodexAccountRows } from "@/components/models/codex-models";
import {
  OrgCodexAccountPage,
  OrgCodexAccessPage,
} from "@/components/models/organization-codex-models";
import { ModelsRefreshControl } from "@/components/models/models-refresh-control";
import { modelsScopeLabels } from "@/components/models/models-ui";
import { OrganizationCodexDetailPrefetch } from "@/components/models/use-organization-codex-overview";
import { Button } from "@/components/ui/button";
import { RowList } from "@/components/ui/list-row";
import { Section } from "@/components/ui/section";
import { useConsoleSharedQueries } from "@/lib/shared-query";
import { currentWorkspace, organization } from "../fixtures";
import { KitCanvas, KitSection } from "../kit";
import { createModelsCacheFixture } from "../pages/models/cache-fixture";

type Page = "list" | "account" | "access" | "away";
type Fixture = ReturnType<typeof createModelsCacheFixture>;

export default function ModelsCacheSection() {
  const initial = new URLSearchParams(window.location.search);
  const [fixture, setFixture] = useState(() =>
    createModelsCacheFixture(initial.get("state") === "loading"),
  );
  const [page, setPage] = useState<Page>(initial.get("page") === "account" ? "account" : "list");
  useConsoleSharedQueries(fixture.client);
  const reads = useSyncExternalStore(fixture.subscribe, fixture.getSnapshot, fixture.getSnapshot);
  return (
    <KitSection sectionKey="page-models-cache">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => setPage("list")}>
          Models
        </Button>
        <Button size="sm" variant="outline" onClick={() => setPage("account")}>
          Account
        </Button>
        <Button size="sm" variant="outline" onClick={() => setPage("away")}>
          Other settings
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setFixture(createModelsCacheFixture(true))}
        >
          Cold load
        </Button>
        <Button size="sm" variant="outline" onClick={fixture.finishLoading}>
          Finish loading
        </Button>
        <span className="text-xs text-fg-muted">Fixture requests: {reads}</span>
      </div>
      <KitCanvas className="min-h-[720px]">
        {page === "away" ? (
          <p>Return to Models to reuse the retained data.</p>
        ) : (
          <ProductionModels fixture={fixture} page={page} navigate={setPage} />
        )}
      </KitCanvas>
    </KitSection>
  );
}

function ProductionModels({
  fixture,
  page,
  navigate,
}: {
  fixture: Fixture;
  page: Exclude<Page, "away">;
  navigate: (page: Page) => void;
}) {
  const codex = useCodexSubscriptions({
    client: fixture.client,
    workspaceId: currentWorkspace.id,
    canManage: true,
  });
  const orgCodex = useOrganizationCodexSubscriptions({
    client: fixture.client,
    organizationId: organization.id,
  });
  const places = {
    organizationName: organization.name,
    workspaceName: currentWorkspace.name,
    scope: modelsScopeLabels(organization.name, false),
    openAccount: () => navigate("account"),
    openConnect: () => undefined,
    openAccess: () => navigate("access"),
    backToList: () => navigate("list"),
  };
  if (page === "account")
    return <OrgCodexAccountPage codex={orgCodex} accountId={fixture.accountId} places={places} />;
  if (page === "access")
    return (
      <OrgCodexAccessPage
        codex={orgCodex}
        accountId={fixture.accountId}
        onClose={() => navigate("account")}
      />
    );
  return (
    <>
      <h1 className="mb-4 text-2xl font-semibold text-fg">Models</h1>
      <ModelsRefreshControl client={fixture.client} />
      {orgCodex.accounts.map((account) => (
        <OrganizationCodexDetailPrefetch
          key={account.id}
          client={fixture.client}
          organizationId={organization.id}
          account={account}
        />
      ))}
      <Section title="Accounts">
        <RowList label="Accounts" columns={ACCOUNT_COLUMNS}>
          <CodexAccountRows
            codex={codex}
            places={places}
            organization={{
              codex: orgCodex,
              workspace: { id: currentWorkspace.id, personal: false },
              openAccount: places.openAccount,
            }}
          />
        </RowList>
      </Section>
    </>
  );
}
