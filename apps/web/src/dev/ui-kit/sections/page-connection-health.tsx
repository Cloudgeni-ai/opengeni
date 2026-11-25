import { useState } from "react";
import "@opengeni/react/connect.css";
import { ConnectionCatalog } from "@opengeni/react/connect";
import {
  capabilityStateChip,
  connectionHealth,
  type ConnectionHealth,
} from "@opengeni/react/app/lib/capabilities";
import type { CapabilityCatalogItem, ConnectionMetadata } from "@opengeni/react/app/types";

import { CapabilityMark } from "@opengeni/react/ui/capability-page";
import { CatalogItemPage } from "@/components/capabilities/catalog-item-page";
import { connectorRowHealth } from "@/components/capabilities/connector-row-health";

import { KitBlock, KitSection, PagePreview } from "../kit";
import { workspaces } from "../fixtures";

/* ----------------------------------------------------------------------------
   Capabilities > Connections and a connector's page, rendered with the real
   list and page components. Both derive health from the same account
   inventory the tool runtime resolves: shared accounts here plus your own
   accounts from every workspace, each saying whether it is turned on here.
   -------------------------------------------------------------------------- */

const HERE = workspaces[0]!;
const ORIGIN = workspaces[1]!;

const GMAIL: CapabilityCatalogItem = {
  id: "mcp:gmail",
  kind: "mcp",
  source: "registry",
  name: "Gmail",
  description: "Search, read, draft, and send email from your Gmail.",
  category: "communication",
  tags: [],
  homepageUrl: "https://developers.google.com/gmail",
  endpointUrl: "https://gmailmcp.googleapis.com/mcp/v1",
  installUrl: null,
  authModel: null,
  providerDomain: "gmailmcp.googleapis.com",
  surfaceType: "mcp",
  transport: null,
  mcpUrl: "https://gmailmcp.googleapis.com/mcp/v1",
  authKind: "oauth2",
  credentialFacts: [],
  tier: null,
  provenance: null,
  logoAssetPath: null,
  importBatchId: null,
  stale: false,
  staleAt: null,
  tools: [],
  runtime: { available: true, notes: null },
  lifecycle: { status: "available", readiness: "ready", detail: null, managedBy: null },
  actions: ["disconnect"],
  enabled: true,
  enabledReason: null,
  connectionRef: {
    providerDomain: "gmailmcp.googleapis.com",
    kind: "oauth2",
    subjectScope: "subject",
  },
  metadata: { curation: { curated: true, official: true } },
} as CapabilityCatalogItem;

/** Your own Gmail account, connected in another workspace. */
function ownAccount(overrides: Partial<ConnectionMetadata>): ConnectionMetadata {
  return {
    id: "6f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f",
    accountId: "acme",
    workspaceId: ORIGIN.id,
    subjectId: "you",
    authorityId: "7a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d",
    providerDomain: "gmailmcp.googleapis.com",
    kind: "oauth2",
    status: "active",
    grantedScopes: [],
    expiresAt: null,
    lastRefreshAt: null,
    lastUsedAt: null,
    lastError: null,
    version: 1,
    metadata: { accountLabel: "you@acme.example" },
    createdBySubjectId: "you",
    updatedBySubjectId: "you",
    createdAt: "2026-11-02T09:00:00Z",
    updatedAt: "2026-11-02T09:00:00Z",
    turnedOnHere: true,
    turnedOnHereGrantId: "8b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e",
    ...overrides,
  } as ConnectionMetadata;
}

const STATES = {
  /** Turned on here with "Use it here": the runtime uses it. */
  useItHere: [ownAccount({})],
  /** Signed out: needs signing in again. */
  signedOut: [ownAccount({ status: "needs_reauth" })],
} satisfies Record<string, ConnectionMetadata[]>;

function Connections({ accounts }: { accounts: ConnectionMetadata[] }) {
  const [repairs, setRepairs] = useState(0);
  const health: ConnectionHealth = connectionHealth(GMAIL, accounts, true);
  return (
    <div className="mx-auto w-full max-w-[960px] px-6 py-8 max-sm:px-4">
      <h2 className="mb-2 text-sm font-semibold text-fg">Connections</h2>
      <ConnectionCatalog
        services={[
          {
            id: "gmail",
            name: "Gmail",
            logo: <CapabilityMark src={null} name="Gmail" />,
            options: [
              {
                id: GMAIL.id,
                name: "Agent tools",
                description: GMAIL.description ?? undefined,
                ...connectorRowHealth({
                  item: GMAIL,
                  health,
                  chip: capabilityStateChip(GMAIL, health),
                  repairable: true,
                  busy: false,
                  onRepair: () => setRepairs((count) => count + 1),
                }),
                connected: GMAIL.enabled,
                onOpen: () => {},
              },
            ],
          },
        ]}
      />
      {repairs ? (
        <p className="mt-3 text-xs text-fg-subtle">Preview only: the repair would run here.</p>
      ) : null}
    </div>
  );
}

function GmailPage({ accounts }: { accounts: ConnectionMetadata[] }) {
  return (
    <div className="mx-auto w-full max-w-[960px] px-6 py-8 max-sm:px-4">
      <CatalogItemPage
        // The preview has no app session for the Approvals section.
        workspaceId=""
        item={GMAIL}
        health={connectionHealth(GMAIL, accounts, true)}
        logoSrc={null}
        busy={false}
        errorMessage={null}
        socialConnections={[]}
        canManageSocial
        canManageSkills
        canTurnOnOrOff
        workspaces={[HERE, ORIGIN]}
        // Accounts from another workspace name where they came from.
        connectionAccounts={{ connections: accounts, workspaceId: HERE.id }}
        onAction={() => {}}
        onBack={() => {}}
      />
    </div>
  );
}

export default function PageConnectionHealthSection() {
  return (
    <KitSection sectionKey="page-connection-health">
      <KitBlock
        title="Turned on here with Use it here"
        description={`Your own Gmail account, connected in ${ORIGIN.name} and turned on in ${HERE.name}. The list and the page both read Connected.`}
      >
        <PagePreview label="Connections list, account turned on here" height={220}>
          <Connections accounts={STATES.useItHere} />
        </PagePreview>
        <PagePreview label="Gmail page, account turned on here" height={760}>
          <GmailPage accounts={STATES.useItHere} />
        </PagePreview>
      </KitBlock>
      <KitBlock
        title="Signed out"
        description="The same account after it needs signing in again. The list and the page name the reason and offer one repair."
      >
        <PagePreview label="Connections list, signed out" height={220}>
          <Connections accounts={STATES.signedOut} />
        </PagePreview>
        <PagePreview label="Gmail page, signed out" height={760}>
          <GmailPage accounts={STATES.signedOut} />
        </PagePreview>
      </KitBlock>
    </KitSection>
  );
}
