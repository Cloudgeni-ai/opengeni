// DEV-only fixtures shaped like the §13B seed, for building and screenshotting
// the Secrets UI before the vault API exists (and for transient states after).
// Every value is fake.
import type { VaultProviderConnectionSummary, VaultProviderOperations } from "@opengeni/sdk";
import type {
  PasskeySummary,
  VaultFieldKind,
  VaultFieldVersionMeta,
  VaultItem,
  VaultItemField,
  VaultItemType,
  VaultSummary,
} from "@opengeni/react";

export const MOCK_NOW = Date.parse("2026-10-12T12:00:10Z");
const iso = (offsetMs: number) => new Date(MOCK_NOW + offsetMs).toISOString();
const DAY = 86_400_000;
const HOUR = 3_600_000;

let counter = 0;
/** Deterministic UUID-shaped ids. */
export function mockId(prefix: string): string {
  counter += 1;
  const hex = counter.toString(16).padStart(12, "0");
  const head = [...prefix]
    .reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 7)
    .toString(16)
    .padStart(8, "0")
    .slice(0, 8);
  return `${head}-5ec0-4000-8000-${hex}`;
}

export type MockField = VaultItemField & {
  /** Plaintext versions, oldest first (fake values). */
  versions: { value: string; createdAt: string; by: VaultFieldVersionMeta["createdByKind"] }[];
};
export type MockItem = Omit<VaultItem, "fields"> & { fields: MockField[] };
/** A vault (or Keeper shared folder) a mock connection can see. */
export type MockProviderVault = {
  externalVaultId: string;
  name: string;
  itemCount: number;
  writeAccess?: "read_only" | "read_write" | "unknown";
};
export type MockState = {
  workspaceId: string;
  vaults: VaultSummary[];
  items: MockItem[];
  connections: VaultProviderConnectionSummary[];
  /** What each connection can see in its password manager. */
  providerVaults: Record<string, MockProviderVault[]>;
  /** `${connectionId}/${externalVaultId}` → linked Opengeni vault id. */
  links: Record<string, string>;
  taskSessionId: string;
  childSessionId: string;
  narrowedSessionId: string;
  sessionPolicies: Record<string, { mode: "all" } | { mode: "selected"; vaultIds: string[] }>;
};

function vault(
  workspaceId: string,
  partial: Partial<VaultSummary> & Pick<VaultSummary, "name" | "ownerKind">,
): VaultSummary {
  return {
    id: mockId(partial.name),
    workspaceId,
    ownerLabel:
      partial.ownerKind === "user"
        ? "Only me"
        : partial.ownerKind === "workspace"
          ? "Platform engineering"
          : partial.ownerKind === "organization"
            ? "Acme"
            : "This task",
    rootSessionId: null,
    description: null,
    source: "opengeni",
    mode: "read_write",
    syncStatus: "ok",
    syncErrorCode: null,
    syncErrorMessage: null,
    lastSyncedAt: null,
    rateLimitedUntil: null,
    providerConnectionId: null,
    availability: null,
    isDefault: false,
    itemCount: 0,
    canWrite: true,
    canManage: true,
    generation: 1,
    createdAt: iso(-90 * DAY),
    updatedAt: iso(-2 * DAY),
    ...partial,
  };
}

type FieldSpec = {
  name: string;
  kind: VaultFieldKind;
  values: string[];
  fileName?: string;
  fileSize?: number;
};

/* What each first-wave provider lets Opengeni do, per the external-vaults design. */
export const NO_OPERATIONS: VaultProviderOperations = {
  createItemTypes: [],
  updateItem: false,
  removeField: false,
  archiveItem: false,
  archiveKind: "none",
  deleteItem: false,
  restoreItem: false,
  readFiles: true,
  writeFiles: false,
  createTotp: false,
  updateTotp: false,
  createVault: false,
  restoreFieldHistory: false,
};
const NONE = NO_OPERATIONS;
export const MOCK_OPERATIONS: Record<
  VaultProviderConnectionSummary["provider"],
  VaultProviderOperations
> = {
  onepassword: {
    ...NONE,
    createItemTypes: ["login", "api_key", "note"],
    updateItem: true,
    removeField: true,
    archiveItem: true,
    archiveKind: "archive",
    createTotp: true,
    updateTotp: true,
    createVault: true,
  },
  // pass-cli: create and recoverable trash; no update, no file writes, TOTP create only.
  protonpass: {
    ...NONE,
    createItemTypes: ["login", "note"],
    archiveItem: true,
    archiveKind: "trash",
    readFiles: false,
    createTotp: true,
  },
  // Secrets Manager: login and note records; no archive; write grant unknown per folder.
  keeper: {
    ...NONE,
    createItemTypes: ["login", "note"],
    updateItem: true,
    removeField: true,
    createTotp: true,
    updateTotp: true,
  },
  // Bridge: edits with revision checks, trash for removal, no attachment writes.
  bitwarden: {
    ...NONE,
    createItemTypes: ["login", "note"],
    updateItem: true,
    removeField: true,
    archiveItem: true,
    archiveKind: "trash",
    createTotp: true,
    updateTotp: true,
  },
  external: {
    ...NONE,
    createItemTypes: ["login", "api_key", "note"],
    updateItem: true,
    removeField: true,
    archiveItem: true,
    archiveKind: "archive",
    createTotp: true,
    updateTotp: true,
  },
};

function refPath(vaultName: string, itemName: string, field?: string): string {
  return `{{secret:${[vaultName, itemName, field].filter(Boolean).join("/")}}}`;
}

function item(
  owner: VaultSummary,
  spec: {
    name: string;
    type: VaultItemType;
    fields: FieldSpec[];
    websites?: string[];
    expiresAt?: string | null;
    aliases?: string[];
    passkey?: PasskeySummary | null;
    updatedAgo?: number;
    lastUsedAgo?: number | null;
    archived?: boolean;
  },
): MockItem {
  const updatedAt = iso(-(spec.updatedAgo ?? 3 * DAY));
  const provider = owner.source !== "opengeni";
  const fields: MockField[] = spec.fields.map((field, position) => ({
    id: mockId(`${spec.name}/${field.name}`),
    name: field.name,
    kind: field.kind,
    position,
    currentVersion: provider ? null : field.values.length,
    value: field.kind === "text" ? (field.values.at(-1) ?? "") : null,
    fileName: field.fileName ?? null,
    fileSize: field.fileSize ?? null,
    reference:
      field.kind === "file"
        ? `{{secretfile:${owner.name}/${spec.name}/${field.name}}}`
        : refPath(owner.name, spec.name, field.name),
    updatedAt,
    versions: field.values.map((value, index) => ({
      value,
      createdAt: iso(-(field.values.length - index) * 20 * DAY),
      by: provider ? "provider" : index === 0 ? "migration" : "human",
    })),
  }));
  const primaryName =
    spec.type === "login"
      ? "password"
      : spec.type === "api_key"
        ? "value"
        : spec.type === "note"
          ? "note"
          : spec.type === "file"
            ? "file"
            : null;
  const primary = fields.find((field) => field.name === primaryName) ?? null;
  const totp = fields.find((field) => field.kind === "totp") ?? null;
  const username = fields.find((field) => field.name === "username")?.value ?? null;
  return {
    id: mockId(`${owner.name}/${spec.name}`),
    vaultId: owner.id,
    type: spec.type,
    name: spec.name,
    websites: spec.websites ?? [],
    username,
    hasTotp: Boolean(totp),
    hasPasskey: spec.type === "passkey",
    expiresAt: spec.expiresAt ?? null,
    archivedAt: spec.archived ? iso(-DAY) : null,
    lastUsedAt: spec.lastUsedAgo === null ? null : iso(-(spec.lastUsedAgo ?? 5 * HOUR)),
    updatedAt,
    references: {
      // As the API's vaultItemReferences: every reference names its field.
      primary: primary ? refPath(owner.name, spec.name, primary.name) : null,
      otp: totp ? `${refPath(owner.name, spec.name, totp.name).slice(0, -2)}/otp}}` : null,
      byField: Object.fromEntries(fields.map((field) => [field.name, field.reference])),
    },
    fields,
    passkey: spec.passkey ?? null,
    aliases: spec.aliases ?? [],
    primaryFieldId: primary?.id ?? null,
    createdBySubjectId: null,
    createdAt: iso(-60 * DAY),
    generation: 1,
  };
}

const login = (username: string, password: string, extra: FieldSpec[] = []): FieldSpec[] => [
  { name: "username", kind: "text", values: [username] },
  { name: "password", kind: "concealed", values: [password] },
  ...extra,
];
const apiKey = (...values: string[]): FieldSpec[] => [{ name: "value", kind: "concealed", values }];
const note = (text: string): FieldSpec[] => [{ name: "note", kind: "concealed", values: [text] }];

const DENSE_WORDS = [
  "Analytics",
  "Billing",
  "Build cache",
  "CDN",
  "CI runner",
  "Data warehouse",
  "Docs search",
  "Email relay",
  "Feature flags",
  "Grafana",
  "Kafka",
  "Logging",
  "Maps",
  "Metrics",
  "Object storage",
  "Payments",
  "Queue",
  "Redis",
  "Search",
  "SMS gateway",
];

export function buildMockState(workspaceId: string): MockState {
  counter = 0;
  const privateVault = vault(workspaceId, {
    name: "Private",
    ownerKind: "user",
    isDefault: true,
    description: "Your own logins and keys.",
  });
  const shared = vault(workspaceId, {
    name: "Shared",
    ownerKind: "workspace",
    isDefault: true,
    description: "Credentials the whole team's agents use.",
  });
  const dense = vault(workspaceId, { name: "Dense", ownerKind: "workspace" });
  const empty = vault(workspaceId, { name: "Empty", ownerKind: "workspace" });
  const orgTooling = vault(workspaceId, {
    name: "Org tooling",
    ownerKind: "organization",
    availability: { allowedWorkspaceIds: null, allowPersonalWorkspaces: true },
    description: "Monitoring and on-call tokens for every team.",
  });
  const noPersonal = vault(workspaceId, {
    name: "No personal",
    ownerKind: "organization",
    availability: { allowedWorkspaceIds: null, allowPersonalWorkspaces: false },
  });
  const connectionId = mockId("1password-connection");
  const personalConnectionId = mockId("1password-personal");
  const opEngineering = vault(workspaceId, {
    name: "1P Engineering",
    ownerKind: "workspace",
    source: "onepassword",
    mode: "read_only",
    providerConnectionId: connectionId,
    lastSyncedAt: iso(-4 * 60_000),
  });
  const opShared = vault(workspaceId, {
    name: "1P Shared",
    ownerKind: "workspace",
    source: "onepassword",
    mode: "read_write",
    providerConnectionId: connectionId,
    syncStatus: "error",
    syncErrorCode: "provider_unavailable",
    syncErrorMessage: "1Password didn't respond.",
    lastSyncedAt: iso(-3 * HOUR),
  });
  const opPersonal = vault(workspaceId, {
    name: "Personal",
    ownerKind: "user",
    source: "onepassword",
    mode: "read_only",
    providerConnectionId: personalConnectionId,
    lastSyncedAt: iso(-9 * 60_000),
  });
  const protonConnectionId = mockId("protonpass-connection");
  const keeperConnectionId = mockId("keeper-connection");
  const bitwardenConnectionId = mockId("bitwarden-connection");
  const externalConnectionId = mockId("external-connection");
  const protonOps = vault(workspaceId, {
    name: "Proton Ops",
    ownerKind: "workspace",
    source: "protonpass",
    mode: "read_write",
    providerConnectionId: protonConnectionId,
    providerOperations: MOCK_OPERATIONS.protonpass,
    freshness: {
      state: "current",
      lastCheckedAt: iso(-6 * 60_000),
      sourceSyncedAt: null,
      source: "live",
      errorCode: null,
      retryAt: null,
    },
    lastSyncedAt: iso(-6 * 60_000),
  });
  const keeperProduction = vault(workspaceId, {
    name: "Keeper Production",
    ownerKind: "organization",
    availability: { allowedWorkspaceIds: null, allowPersonalWorkspaces: false },
    source: "keeper",
    mode: "read_write",
    providerConnectionId: keeperConnectionId,
    providerOperations: MOCK_OPERATIONS.keeper,
    lastSyncedAt: iso(-12 * 60_000),
  });
  const bitwardenPersonal = vault(workspaceId, {
    name: "Bitwarden Personal",
    ownerKind: "user",
    availability: { allowedWorkspaceIds: null, allowPersonalWorkspaces: true },
    source: "bitwarden",
    mode: "read_write",
    providerConnectionId: bitwardenConnectionId,
    providerOperations: MOCK_OPERATIONS.bitwarden,
    freshness: {
      state: "current",
      lastCheckedAt: iso(-2 * 60_000),
      sourceSyncedAt: iso(-47 * 60_000),
      source: "cache",
      errorCode: null,
      retryAt: null,
    },
    lastSyncedAt: iso(-2 * 60_000),
  });
  const serviceCredentials = vault(workspaceId, {
    name: "Service credentials",
    ownerKind: "workspace",
    source: "external",
    mode: "read_only",
    providerConnectionId: externalConnectionId,
    providerOperations: NONE,
    lastSyncedAt: iso(-3 * 60_000),
  });
  const taskSessionId = mockId("task-session");
  const childSessionId = mockId("child-session");
  const narrowedSessionId = mockId("narrowed-session");
  const taskVault = vault(workspaceId, {
    name: "Task",
    ownerKind: "task",
    rootSessionId: taskSessionId,
  });

  const items: MockItem[] = [
    item(privateVault, {
      name: "GitHub",
      type: "login",
      websites: ["https://github.com"],
      fields: login("bendik-acme", "fake-Gh!8vQ2#pLm4xZ", [
        { name: "one-time password", kind: "totp", values: ["JBSWY3DPEHPK3PXP"] },
      ]),
      lastUsedAgo: 40 * 60_000,
    }),
    item(privateVault, {
      name: "Fake Login Passkey",
      type: "passkey",
      websites: ["http://localhost"],
      fields: [
        { name: "rpId", kind: "text", values: ["localhost"] },
        { name: "userName", kind: "text", values: ["bendik@acme.dev"] },
      ],
      passkey: {
        rpId: "localhost",
        userName: "bendik@acme.dev",
        credentialIdSuffix: "Q2x5mN8a",
        signCount: 14,
        leasedUntil: null,
        lastUsedAt: iso(-2 * DAY),
      },
    }),
    item(privateVault, {
      name: "OpenAI API",
      type: "api_key",
      websites: ["https://platform.openai.com"],
      fields: apiKey("sk-fake-proj-7Hc2Vb9QmX4nT1kLw0Ae"),
    }),
    item(privateVault, {
      name: "Recovery codes",
      type: "note",
      fields: note("fake-1a2b-3c4d\nfake-5e6f-7a8b\nfake-9c0d-1e2f"),
      lastUsedAgo: null,
    }),
    item(privateVault, {
      name: "Service account",
      type: "file",
      fields: [
        {
          name: "file",
          kind: "file",
          values: ['{"type":"service_account","project_id":"fake"}'],
          fileName: "service-account.json",
          fileSize: 3_072,
        },
      ],
    }),
    item(shared, {
      name: "Deploy key",
      type: "api_key",
      fields: apiKey("fake-deploy-v1-aaaa", "fake-deploy-v2-bbbb", "fake-deploy-v3-cccc"),
      updatedAgo: 6 * DAY,
    }),
    item(shared, {
      name: "Staging DB",
      type: "login",
      aliases: ["Staging database"],
      websites: ["staging-db.internal.acme.dev"],
      fields: login("app_staging", "fake-st4g1ng-pw"),
    }),
    item(shared, {
      name: "Expired cert",
      type: "note",
      expiresAt: iso(-5 * DAY),
      fields: note("-----BEGIN FAKE CERTIFICATE-----"),
    }),
    item(shared, {
      name: "Rotating soon",
      type: "api_key",
      expiresAt: iso(3 * DAY),
      fields: apiKey("fake-rotating-key"),
    }),
    item(shared, {
      name: "Fake Login – password",
      type: "login",
      websites: ["http://127.0.0.1:47420"],
      fields: login("agent@acme.dev", "fake-login-pw"),
    }),
    item(shared, {
      name: "Fake Login – TOTP",
      type: "login",
      websites: ["http://127.0.0.1:47420"],
      fields: login("agent-totp@acme.dev", "fake-login-pw-2", [
        { name: "one-time password", kind: "totp", values: ["GEZDGNBVGY3TQOJQ"] },
      ]),
    }),
    item(orgTooling, {
      name: "Sentry token",
      type: "api_key",
      websites: ["https://sentry.io"],
      fields: apiKey("fake-sentry-token"),
    }),
    item(orgTooling, {
      name: "PagerDuty",
      type: "login",
      websites: ["https://acme.pagerduty.com"],
      fields: login("oncall@acme.dev", "fake-pd-pw"),
    }),
    item(noPersonal, {
      name: "Shared calendar",
      type: "login",
      fields: login("calendar@acme.dev", "fake-cal"),
    }),
    ...["Bank", "Email"].map((name) =>
      item(opPersonal, {
        name,
        type: "login",
        fields: login("me@example.com", `fake-${name}`),
        lastUsedAgo: null,
      }),
    ),
    ...["AWS console", "Datadog", "Linear", "Notion", "Vercel", "Cloudflare"].map((name) =>
      item(opEngineering, {
        name,
        type: "login",
        websites: [`https://${name.toLowerCase().replace(/\s+/g, "")}.com`],
        fields: login(`eng@acme.dev`, `fake-${name}`),
        lastUsedAgo: null,
      }),
    ),
    ...["Figma", "Slack admin", "Zoom"].map((name) =>
      item(opShared, {
        name,
        type: "login",
        fields: login(`team@acme.dev`, `fake-${name}`),
        lastUsedAgo: null,
      }),
    ),
    item(protonOps, {
      name: "Grafana",
      type: "login",
      websites: ["https://grafana.acme.dev"],
      fields: login("ops@acme.dev", "fake-grafana", [
        { name: "one-time password", kind: "totp", values: ["JBSWY3DPEHPK3PXP"] },
      ]),
      lastUsedAgo: 2 * HOUR,
    }),
    ...["PagerDuty", "Sentry"].map((name) =>
      item(protonOps, {
        name,
        type: "login",
        websites: [`https://${name.toLowerCase()}.com`],
        fields: login("ops@acme.dev", `fake-${name}`),
        lastUsedAgo: null,
      }),
    ),
    item(protonOps, { name: "Runbook notes", type: "note", fields: note("fake-runbook") }),
    ...["Stripe live", "Postgres primary", "Twilio"].map((name) =>
      item(keeperProduction, {
        name,
        type: name === "Twilio" ? "note" : "login",
        fields: name === "Twilio" ? note("fake-twilio") : login("prod@acme.dev", `fake-${name}`),
        lastUsedAgo: 30 * 60_000,
      }),
    ),
    item(keeperProduction, {
      name: "Signing certificate",
      type: "login",
      fields: [
        { name: "username", kind: "text", values: ["release@acme.dev"] },
        { name: "password", kind: "concealed", values: ["fake-cert-pw"] },
        {
          name: "certificate",
          kind: "file",
          values: ["fake-cert"],
          fileName: "release-signing.p12",
          fileSize: 4_812,
        },
      ],
    }),
    ...["Home router", "Bank"].map((name) =>
      item(bitwardenPersonal, {
        name,
        type: "login",
        fields: login("ola@example.com", `fake-${name}`),
        lastUsedAgo: null,
      }),
    ),
    ...["Billing API", "Search index"].map((name) =>
      item(serviceCredentials, {
        name,
        type: "api_key",
        fields: apiKey(`fake-${name}`),
        lastUsedAgo: HOUR,
      }),
    ),
    item(taskVault, {
      name: "Temp signup",
      type: "login",
      websites: ["https://app.example.com"],
      fields: login("agent+signup@acme.dev", "fake-temp-pw"),
    }),
    item(taskVault, {
      name: "OTP backup",
      type: "note",
      fields: note("fake-backup-codes"),
    }),
  ];

  for (let index = 0; index < 140; index += 1) {
    const word = DENSE_WORDS[index % DENSE_WORDS.length]!;
    const env = ["production", "staging", "dev", "eu-west", "us-east", "sandbox", "ci"][index % 7]!;
    const type: VaultItemType = (["login", "api_key", "api_key", "note", "login"] as const)[
      index % 5
    ]!;
    const long = index % 23 === 5;
    const name = long
      ? `${word} ${env} service account for the nightly data export and reconciliation job ${index}`
      : `${word} ${env} ${index + 1}`;
    const withTotp = type === "login" && index % 3 !== 2 && index < 120;
    items.push(
      item(dense, {
        name,
        type,
        websites:
          index === 7
            ? Array.from({ length: 10 }, (_, n) => `https://site-${n + 1}.example.com`)
            : type === "login"
              ? [`https://${word.toLowerCase().replace(/\s+/g, "-")}.example.com`]
              : [],
        fields:
          type === "login"
            ? login(
                `svc-${index}@acme.dev`,
                `fake-${index}`,
                withTotp
                  ? [{ name: "one-time password", kind: "totp", values: ["JBSWY3DPEHPK3PXP"] }]
                  : [],
              )
            : type === "api_key"
              ? apiKey(`fake-key-${index}`)
              : note(`fake note ${index}`),
        expiresAt: index % 37 === 3 ? iso(-DAY) : index % 41 === 9 ? iso(5 * DAY) : null,
        updatedAgo: (index % 30) * DAY + HOUR,
        lastUsedAgo: index % 4 === 0 ? null : (index % 9) * HOUR + 60_000,
      }),
    );
  }

  const vaults = [
    privateVault,
    shared,
    dense,
    empty,
    orgTooling,
    noPersonal,
    opEngineering,
    opShared,
    opPersonal,
    protonOps,
    keeperProduction,
    bitwardenPersonal,
    serviceCredentials,
    taskVault,
  ];
  for (const each of vaults) {
    each.itemCount = items.filter((entry) => entry.vaultId === each.id && !entry.archivedAt).length;
  }
  const connections: VaultProviderConnectionSummary[] = [
    {
      id: connectionId,
      provider: "onepassword",
      ownership: "workspace",
      accountName: "acme.1password.com",
      label: null,
      planTier: "business",
      verifiedAt: iso(-4 * 60_000),
      createdAt: iso(-12 * DAY),
      createdBySubjectId: null,
      canManage: true,
      operations: MOCK_OPERATIONS.onepassword,
      available: true,
    },
    {
      id: personalConnectionId,
      provider: "onepassword",
      ownership: "user",
      accountName: "my.1password.com",
      label: null,
      planTier: "family",
      verifiedAt: iso(-9 * 60_000),
      createdAt: iso(-2 * DAY),
      createdBySubjectId: null,
      canManage: true,
      operations: MOCK_OPERATIONS.onepassword,
      available: true,
    },
    {
      id: protonConnectionId,
      provider: "protonpass",
      ownership: "workspace",
      accountName: "ops@acme.dev",
      label: null,
      verifiedAt: iso(-6 * 60_000),
      createdAt: iso(-5 * DAY),
      createdBySubjectId: null,
      canManage: true,
      operations: MOCK_OPERATIONS.protonpass,
      available: true,
    },
    {
      id: keeperConnectionId,
      provider: "keeper",
      ownership: "organization",
      accountName: "Opengeni agents",
      label: null,
      verifiedAt: iso(-12 * 60_000),
      createdAt: iso(-20 * DAY),
      createdBySubjectId: null,
      canManage: true,
      operations: MOCK_OPERATIONS.keeper,
      available: true,
    },
    {
      id: bitwardenConnectionId,
      provider: "bitwarden",
      ownership: "user",
      accountName: "ola@example.com",
      label: "Laptop bridge",
      verifiedAt: iso(-2 * 60_000),
      createdAt: iso(-1 * DAY),
      createdBySubjectId: null,
      canManage: true,
      operations: MOCK_OPERATIONS.bitwarden,
      available: true,
    },
    {
      id: externalConnectionId,
      provider: "external",
      ownership: "workspace",
      accountName: "vaults.acme.internal",
      label: "Acme vault service",
      verifiedAt: iso(-3 * 60_000),
      createdAt: iso(-30 * DAY),
      createdBySubjectId: null,
      canManage: true,
      operations: MOCK_OPERATIONS.external,
      available: true,
    },
  ];
  return {
    workspaceId,
    vaults,
    items,
    connections,
    providerVaults: {
      [connectionId]: [
        { externalVaultId: "op-eng", name: "1P Engineering", itemCount: 6 },
        { externalVaultId: "op-shared", name: "1P Shared", itemCount: 3 },
        { externalVaultId: "op-mkt", name: "Marketing", itemCount: 7 },
        { externalVaultId: "op-finance", name: "Finance", itemCount: 12 },
      ],
      [personalConnectionId]: [
        { externalVaultId: "op-personal", name: "Personal", itemCount: 2 },
        { externalVaultId: "op-family", name: "Family", itemCount: 31 },
      ],
      [protonConnectionId]: [
        { externalVaultId: "pp-ops", name: "Proton Ops", itemCount: 4, writeAccess: "read_write" },
        {
          externalVaultId: "pp-infra",
          name: "Infrastructure",
          itemCount: 18,
          writeAccess: "read_only",
        },
      ],
      [keeperConnectionId]: [
        {
          externalVaultId: "kp-prod",
          name: "Keeper Production",
          itemCount: 4,
          writeAccess: "unknown",
        },
        { externalVaultId: "kp-staging", name: "Staging", itemCount: 9, writeAccess: "unknown" },
      ],
      [bitwardenConnectionId]: [
        {
          externalVaultId: "bw-personal",
          name: "Bitwarden Personal",
          itemCount: 2,
          writeAccess: "read_write",
        },
        {
          externalVaultId: "bw-family",
          name: "Family organization",
          itemCount: 14,
          writeAccess: "read_only",
        },
      ],
      [externalConnectionId]: [
        {
          externalVaultId: "ext-svc",
          name: "Service credentials",
          itemCount: 2,
          writeAccess: "read_only",
        },
      ],
    },
    links: {
      [`${connectionId}/op-eng`]: opEngineering.id,
      [`${connectionId}/op-shared`]: opShared.id,
      [`${personalConnectionId}/op-personal`]: opPersonal.id,
      [`${protonConnectionId}/pp-ops`]: protonOps.id,
      [`${keeperConnectionId}/kp-prod`]: keeperProduction.id,
      [`${bitwardenConnectionId}/bw-personal`]: bitwardenPersonal.id,
      [`${externalConnectionId}/ext-svc`]: serviceCredentials.id,
    },
    taskSessionId,
    childSessionId,
    narrowedSessionId,
    sessionPolicies: {
      [narrowedSessionId]: { mode: "selected", vaultIds: [shared.id, orgTooling.id] },
    },
  };
}
