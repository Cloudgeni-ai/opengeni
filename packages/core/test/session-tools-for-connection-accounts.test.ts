import { expect, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import { sessionToolsForConnectionAccounts } from "../src/domain/sessions";

const opengeni = { id: "opengeni", url: "https://first-party.test/mcp" };
const mail = {
  id: "cap-mail",
  url: "https://mail.example.test/mcp",
  connectionRef: {
    providerDomain: "mail.example.test",
    kind: "oauth2" as const,
    subjectScope: "subject" as const,
  },
};
const crm = { id: "cap-crm", url: "https://crm.example.test/mcp" };
const settings = { mcpServers: [] } as unknown as Pick<Settings, "mcpServers">;
const runtimeSettings = {
  mcpServers: [opengeni, mail, crm],
} as unknown as Pick<Settings, "mcpServers">;
const ids = (tools: { id: string }[]) => tools.map((tool) => tool.id).sort();

test("a workspace-default session expands the default connectors it executes with", () => {
  expect(
    ids(
      sessionToolsForConnectionAccounts({
        session: {
          tools: [{ kind: "mcp", id: "opengeni" }],
          toolPolicy: {
            mode: "workspace_default",
            inheritedFromSessionId: null,
          },
        },
        settings,
        runtimeSettings,
        workspaceSessionToolDefaults: null,
      }),
    ),
  ).toEqual(["cap-crm", "cap-mail", "opengeni"]);
});

test("explicit workspace defaults and exclusions bound the expansion", () => {
  expect(
    ids(
      sessionToolsForConnectionAccounts({
        session: {
          tools: [],
          toolPolicy: {
            mode: "workspace_default",
            inheritedFromSessionId: null,
            excludedMcpServerIds: ["cap-crm"],
          },
        },
        settings,
        runtimeSettings,
        workspaceSessionToolDefaults: { mcpServerIds: ["cap-mail", "cap-crm"] },
      }),
    ),
  ).toEqual(["cap-mail", "opengeni"]);
});

test("an explicit session keeps its stored selection", () => {
  expect(
    ids(
      sessionToolsForConnectionAccounts({
        session: {
          tools: [{ kind: "mcp", id: "cap-crm" }],
          toolPolicy: { mode: "explicit", inheritedFromSessionId: null },
        },
        settings,
        runtimeSettings,
        workspaceSessionToolDefaults: null,
      }),
    ),
  ).toEqual(["cap-crm", "opengeni"]);
});
