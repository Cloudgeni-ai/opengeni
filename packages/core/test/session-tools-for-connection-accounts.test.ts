import { expect, test } from "bun:test";
import { sessionToolsForConnectionAccounts } from "../src/domain/sessions";
import { workspaceSessionToolPolicyDefaultServerIdsFor } from "../src/domain/session-tool-policy";

const opengeni = { id: "opengeni" };
// A deployment-configured (static) connector and a capability-installed one
// are both part of the resolved runtime registry.
const staticMail = { id: "static-mail" };
const capCrm = { id: "cap-crm" };
const runtimeMcpServers = [opengeni, staticMail, capCrm];
const ids = (tools: { id: string }[]) => tools.map((tool) => tool.id).sort();

test("without a workspace override every configured runtime connector is a default", () => {
  expect(workspaceSessionToolPolicyDefaultServerIdsFor(runtimeMcpServers, null)).toEqual([
    "cap-crm",
    "static-mail",
  ]);
  expect(workspaceSessionToolPolicyDefaultServerIdsFor(runtimeMcpServers, {})).toEqual([
    "cap-crm",
    "static-mail",
  ]);
});

test("an explicit workspace override bounds the default set to available ids", () => {
  expect(
    workspaceSessionToolPolicyDefaultServerIdsFor(runtimeMcpServers, {
      sessionToolDefaults: { mcpServerIds: ["static-mail", "retired"] },
    }),
  ).toEqual(["static-mail"]);
});

test("a workspace-default session freezes accounts against the current defaults, including a static connector absent from its stored snapshot", () => {
  expect(
    ids(
      sessionToolsForConnectionAccounts({
        session: {
          tools: [{ kind: "mcp", id: "opengeni" }],
          toolPolicy: { mode: "workspace_default", inheritedFromSessionId: null },
        },
        runtimeMcpServers,
        defaultMcpServerIds: workspaceSessionToolPolicyDefaultServerIdsFor(runtimeMcpServers, null),
      }),
    ),
  ).toEqual(["cap-crm", "opengeni", "static-mail"]);
});

test("exclusions remove a default connector from the freeze list", () => {
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
        runtimeMcpServers,
        defaultMcpServerIds: ["static-mail", "cap-crm"],
      }),
    ),
  ).toEqual(["opengeni", "static-mail"]);
});

test("an explicit session keeps its stored selection and never adopts defaults", () => {
  expect(
    ids(
      sessionToolsForConnectionAccounts({
        session: {
          tools: [{ kind: "mcp", id: "cap-crm" }],
          toolPolicy: { mode: "explicit", inheritedFromSessionId: null },
        },
        runtimeMcpServers,
        defaultMcpServerIds: ["static-mail", "cap-crm"],
      }),
    ),
  ).toEqual(["cap-crm", "opengeni"]);
});
