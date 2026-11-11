import type { ApiKey, OrganizationServiceAccount } from "@opengeni/sdk";
import { useMemo, useState } from "react";

import {
  ServiceAccounts,
  type ServiceAccountsApi,
  type ServiceAccountsLocation,
} from "@/components/organization-access/service-accounts";
import { OrganizationApiKeysSection } from "@/components/organization-api-keys-section";
import { presetPermissions } from "@/lib/organization-access";

import { KitBlock, KitSection, PagePreview } from "../kit";
import { organization, workspaces } from "../fixtures";

// Relative to the real clock: RelativeTime counts from now.
const PREVIEW_NOW = Date.now();
const ago = (days: number) => new Date(PREVIEW_NOW - days * 86_400_000).toISOString();

const ACCOUNTS: OrganizationServiceAccount[] = [
  {
    id: "8b3f2e6c-3d4e-4f5a-8b6c-2d3e4f5a6b72",
    organizationId: organization.id,
    name: "Release pipeline",
    description: "Deploys and runs the nightly evals",
    role: "admin",
    activeKeyCount: 2,
    createdAt: ago(40),
    updatedAt: ago(2),
  },
  {
    id: "9c4a3f7d-4e5f-4a6b-9c7d-3e4f5a6b7c83",
    organizationId: organization.id,
    name: "Support assistant",
    description: null,
    role: "member",
    activeKeyCount: 1,
    createdAt: ago(12),
    updatedAt: ago(12),
  },
];

const shared = workspaces.filter((workspace) => workspace.kind !== "personal");

function previewKey(
  id: string,
  name: string,
  holder: OrganizationServiceAccount,
  readOnly: boolean,
): ApiKey {
  return {
    id,
    accountId: organization.id,
    workspaceId: null,
    name,
    description: null,
    prefix: `og_org_${id.slice(0, 4)}`,
    permissions: presetPermissions(readOnly ? "read_only" : "full"),
    policy: {
      preset: readOnly ? "read_only" : "full",
      permissions: presetPermissions(readOnly ? "read_only" : "full"),
      workspaceScope: { kind: "all" },
    },
    permissionMode: "explicit",
    serviceAccount: { id: holder.id, name: holder.name, role: holder.role },
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: ago(1),
    createdAt: ago(30),
    updatedAt: ago(30),
  } as ApiKey;
}

const KEYS: ApiKey[] = [
  previewKey("a1b2c3d4-0000-4000-8000-000000000001", "Deploy", ACCOUNTS[0]!, false),
  previewKey("a1b2c3d4-0000-4000-8000-000000000002", "Nightly evals", ACCOUNTS[0]!, false),
  previewKey("a1b2c3d4-0000-4000-8000-000000000003", "Helpdesk", ACCOUNTS[1]!, true),
];

function fakeApi(initial: OrganizationServiceAccount[]): ServiceAccountsApi {
  let accounts = [...initial];
  return {
    list: async () => accounts,
    get: async (id) => accounts.find((each) => each.id === id)!,
    create: async (request) => {
      const created = {
        ...ACCOUNTS[1]!,
        id: crypto.randomUUID(),
        name: request.name,
        role: request.role ?? "member",
        activeKeyCount: 0,
      };
      accounts = [created, ...accounts];
      return created;
    },
    update: async (id, request) => {
      accounts = accounts.map((each) =>
        each.id === id
          ? {
              ...each,
              ...(request.name ? { name: request.name } : {}),
              ...(request.role ? { role: request.role } : {}),
            }
          : each,
      );
      return accounts.find((each) => each.id === id)!;
    },
    remove: async (id) => {
      accounts = accounts.filter((each) => each.id !== id);
    },
    listKeys: async () => KEYS,
  };
}

const LIST: ServiceAccountsLocation = {};

function AccountsPreview({
  initial,
  start = LIST,
  canMakeAdmin = true,
}: {
  initial: OrganizationServiceAccount[];
  start?: ServiceAccountsLocation;
  canMakeAdmin?: boolean;
}) {
  const api = useMemo(() => fakeApi(initial), [initial]);
  const [location, setLocation] = useState<ServiceAccountsLocation>(start);
  return (
    <div className="mx-auto w-full max-w-[960px] px-6 py-8 max-sm:px-4">
      <ServiceAccounts
        api={api}
        canMakeAdmin={canMakeAdmin}
        location={location}
        onNavigate={setLocation}
        onCreateKey={() => setLocation({})}
      />
    </div>
  );
}

export default function PageServiceAccountsSection() {
  return (
    <KitSection sectionKey="page-service-accounts">
      <KitBlock
        title="Service accounts"
        description="Organization settings > Developer. Each row says its role and how many keys it holds. A row opens its page."
      >
        <PagePreview label="Service accounts" height={380}>
          <AccountsPreview initial={ACCOUNTS} />
        </PagePreview>
      </KitBlock>
      <KitBlock title="Empty" description="The empty list holds the one action.">
        <PagePreview label="No service accounts" height={440}>
          <AccountsPreview initial={[]} />
        </PagePreview>
      </KitBlock>
      <KitBlock
        title="New service account"
        description="A name, an optional description and a role. Member is the default; only admins can choose Admin."
      >
        <PagePreview label="New service account" height={720}>
          <AccountsPreview initial={ACCOUNTS} start={{ view: "new-service-account" }} />
        </PagePreview>
      </KitBlock>
      <KitBlock
        title="A service account"
        description="Editable in place; Save shows once something changed. Its keys are listed with Create key. Delete is in the ⋯ menu and revokes its keys."
      >
        <PagePreview label="Release pipeline" height={1000}>
          <AccountsPreview initial={ACCOUNTS} start={{ serviceAccount: ACCOUNTS[0]!.id }} />
        </PagePreview>
      </KitBlock>
      <KitBlock
        title="Create API key, held by a service account"
        description="Service account picks who holds the key: a new one named after it, or an existing one."
      >
        <PagePreview label="Create API key" height={1250}>
          <div className="mx-auto w-full max-w-[960px] px-6 py-8 max-sm:px-4">
            <OrganizationApiKeysSection
              organizationId={organization.id}
              canManage
              view="new-key"
              onViewChange={() => {}}
              listApiKeys={async () => []}
              createApiKey={async () => {
                throw new Error("Preview only");
              }}
              deleteApiKey={async () => {
                throw new Error("Preview only");
              }}
              workspaces={shared.map((workspace) => ({ id: workspace.id, name: workspace.name }))}
              listServiceAccounts={async () => ACCOUNTS}
              initialServiceAccountId={ACCOUNTS[1]!.id}
            />
          </div>
        </PagePreview>
      </KitBlock>
      <KitBlock
        title="API keys with their holder"
        description="Each key row starts with the service account that holds it."
      >
        <PagePreview label="API keys" height={420}>
          <div className="mx-auto w-full max-w-[960px] px-6 py-8 max-sm:px-4">
            <OrganizationApiKeysSection
              organizationId={organization.id}
              canManage
              listApiKeys={async () => KEYS}
              createApiKey={async () => {
                throw new Error("Preview only");
              }}
              deleteApiKey={async () => {
                throw new Error("Preview only");
              }}
              workspaces={shared.map((workspace) => ({ id: workspace.id, name: workspace.name }))}
            />
          </div>
        </PagePreview>
      </KitBlock>
    </KitSection>
  );
}
