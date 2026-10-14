import type {
  SiteDataCollectionResponse,
  SiteDataDescribeResponse,
  SiteDataQueryRequest,
  SiteDataRecordResponse,
  SiteDataWriteRequest,
} from "@opengeni/sdk";
import type { AppContextValue } from "../src/context";

// Sample data for the Site Data preview. The page, tabs and Data view are the
// production components; only the client and app context are fixtures.
export const workspaceId = "11111111-1111-4111-8111-111111111111";
export const siteId = "44444444-4444-4444-8444-444444444444";
const me = "fixture-owner";
const now = Date.parse("2026-10-13T12:00:00Z");
const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

const collection = (
  name: string,
  accessMode: SiteDataCollectionResponse["accessMode"],
  recordCount: number,
  recordBytes: number,
  extra: Partial<SiteDataCollectionResponse> = {},
): SiteDataCollectionResponse => ({
  id: crypto.randomUUID(),
  name,
  accessMode,
  privateRecords: false,
  jsonSchema: null,
  indexedFields: [],
  uniqueFields: [],
  recordCount,
  recordBytes,
  createdAt: minutesAgo(60 * 24 * 9),
  updatedAt: minutesAgo(12),
  ...extra,
});

const collections = [
  collection("contacts", "shared", 128, 219_340, { uniqueFields: [["email"]] }),
  collection("companies", "shared_read", 42, 98_210),
  collection("follow_ups", "per_viewer", 310, 184_400),
  collection("feedback", "append_only", 57, 41_980),
];

const people = [
  ["Ada Lovelace", "Analytical Engines", "Customer"],
  ["Grace Hopper", "Compiler Works", "Trial"],
  ["Katherine Johnson", "Orbit Labs", "Customer"],
  ["Alan Turing", "Bletchley Systems", "Lead"],
  ["Margaret Hamilton", "Apollo Software", "Customer"],
  ["Edsger Dijkstra", "Shortest Path AS", "Lead"],
  ["Barbara Liskov", "Substitution Inc", "Trial"],
  ["Donald Knuth", "TeX Press", "Customer"],
  ["Radia Perlman", "Spanning Tree Co", "Lead"],
  ["Frances Allen", "Optimizing Compilers", "Customer"],
  ["Tim Berners-Lee", "Hypertext AB", "Trial"],
  ["Leslie Lamport", "Paxos Partners", "Customer"],
] as const;

const contactRecords: SiteDataRecordResponse[] = Array.from({ length: 50 }, (_, index) => {
  const [name, company, stage] = people[index % people.length]!;
  const suffix = index < people.length ? "" : ` ${Math.floor(index / people.length) + 1}`;
  const data = {
    name: `${name}${suffix}`,
    email: `${name.toLowerCase().replaceAll(" ", ".")}${suffix.trim()}@example.com`,
    company,
    stage,
    owner: index % 3 === 0 ? "Bendik" : "Maja",
    lastContact: minutesAgo(index * 97).slice(0, 10),
    notes:
      index === 0
        ? 'Asked for a security review. <script>alert("stored text stays text")</script>'
        : "Follow up after the pilot.",
  };
  return {
    id: crypto.randomUUID(),
    key: null,
    data,
    owner: index % 4 === 0 ? `user:${me}` : "user:another-member",
    createdBy: `user:${me}`,
    updatedBy: `user:${me}`,
    version: (index % 4) + 1,
    sizeBytes: JSON.stringify(data).length + 40,
    createdAt: minutesAgo(60 * 24 * 7 + index),
    updatedAt: minutesAgo(index * 37 + 3),
  };
});

const described: SiteDataDescribeResponse = {
  siteId,
  collections,
  usage: {
    collectionCount: collections.length,
    recordCount: collections.reduce((sum, item) => sum + item.recordCount, 0),
    recordBytes: collections.reduce((sum, item) => sum + item.recordBytes, 0),
    fileCount: 6,
    fileBytes: 3_420_000,
    workspaceBytes: 3_963_930,
  },
  limits: {
    recordBytesPerSite: 100 * 1024 * 1024,
    maxRecordBytes: 256 * 1024,
    maxCollectionsPerSite: 50,
    fileBytesPerSite: 1024 * 1024 * 1024,
    maxFileBytes: 10 * 1024 * 1024,
    workspaceBytes: 1024 * 1024 * 1024,
  },
};

const version = { id: "88888888-8888-4888-8888-888888888888", revision: 4, requestedTools: [] };
export const fixtureActivity = { writes: [] as SiteDataWriteRequest[], exports: [] as string[] };
Object.assign(window, { siteDataFixture: fixtureActivity });

export const client = {
  tools: { forWorkspace: () => ({ $catalog: async () => ({ entries: [] }) }) },
  async getWorkspaceArtifact(_workspaceId: string, id: string) {
    return {
      artifact: {
        id,
        accountId: "99999999-9999-4999-8999-999999999999",
        workspaceId,
        slug: "team-crm",
        title: "Team CRM",
        description: null,
        status: "active",
        visibility: "workspace",
        ownerSubjectId: me,
        currentVersion: version,
        createdAt: minutesAgo(60 * 24 * 9),
        updatedAt: minutesAgo(45),
      },
      versions: [{ ...version, createdAt: minutesAgo(45), sizeBytes: 48_210 }],
      events: [],
    };
  },
  async getSessionTenancyCreateCapabilities() {
    return { canCreatePrivate: true };
  },
  async listSessionPage() {
    return { pinned: [], sessions: [], nextCursor: null, filtersApplied: true };
  },
  async getWorkspaceArtifactHtml() {
    return `<!doctype html><html><body style="font:15px system-ui;margin:32px;color:#1f2328"><h1>Team CRM</h1><p>Contacts are loaded from Site Data.</p></body></html>`;
  },
  async getSiteData() {
    return described;
  },
  async querySiteData(_workspaceId: string, _siteId: string, query: SiteDataQueryRequest) {
    const records = query.collection === "contacts" ? contactRecords : [];
    return {
      records,
      nextCursor: query.collection === "contacts" ? "next-page" : null,
      ...(query.count ? { count: query.collection === "contacts" ? 128 : 0 } : {}),
    };
  },
  async writeSiteData(_workspaceId: string, _siteId: string, request: SiteDataWriteRequest) {
    fixtureActivity.writes.push(request);
    return { results: [] };
  },
  async exportSiteData(_workspaceId: string, _siteId: string, name: string) {
    fixtureActivity.exports.push(name);
    return { content: "[]", contentType: "application/json", truncated: false };
  },
};

export function useAppContext() {
  return {
    client,
    accessKeyVersion: 0,
    busy: false,
    startSession: async () => null,
    authSession: { user: { name: "Bendik" } },
    managedSelfContext: null,
    workspaces: [
      {
        id: workspaceId,
        accountId: "99999999-9999-4999-8999-999999999999",
        name: "Sales",
        kind: "shared",
      },
    ],
    accessContext: {
      subjectId: me,
      workspaceGrants: [
        {
          workspaceId,
          accountId: "99999999-9999-4999-8999-999999999999",
          subjectId: me,
          permissions: ["sessions:create", "sessions:read", "artifacts:read", "artifacts:publish"],
        },
      ],
    },
  } as unknown as AppContextValue;
}
