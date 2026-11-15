import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { SLACK_AGENT_OPEN_LABEL } from "@opengeni/contracts";

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const kit = await import("../../../../../packages/react/test/agents-test-kit");
const { AgentSlackSection, agentSlackErrorText } = await import("./agent-slack-section");

const { makeAgent, appContext, AgentsTestHost } = kit;
const CONNECTION_ID = "cccccccc-cccc-4ccc-8ccc-000000000001";

afterAll(() => GlobalRegistrator.unregister());

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

function availability(patch: Record<string, unknown> = {}) {
  return {
    connectionId: CONNECTION_ID,
    slackTeamId: "T1",
    slackTeamName: "Acme",
    handle: "data-team",
    open: false,
    enabledBySubjectId: "user-me",
    version: 3,
    createdAt: "2026-10-01T09:00:00.000Z",
    updatedAt: "2026-10-01T09:00:00.000Z",
    ...patch,
  };
}

async function render(
  agent: ReturnType<typeof makeAgent>,
  client: Record<string, unknown>,
  onIntroduce: (connectionId: string) => void = () => undefined,
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  await act(async () =>
    root.render(
      <AgentsTestHost context={appContext(client)}>
        <AgentSlackSection agent={agent} onIntroduce={onIntroduce} />
      </AgentsTestHost>,
    ),
  );
  for (let index = 0; index < 3; index += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  return container;
}

function installs(rows: Record<string, unknown>[]) {
  return async () => ({ installs: rows, routingEnabled: true });
}

function row(patch: Record<string, unknown> = {}) {
  return {
    connectionId: CONNECTION_ID,
    slackTeamId: "T1",
    slackTeamName: "Acme",
    availability: availability(),
    unavailable: null,
    ...patch,
  };
}

test("a shared agent is in each linked Slack workspace, with how people ask it and no switch", async () => {
  const agent = makeAgent({
    name: "Data team",
    slack: [availability()],
    viewer: { canEdit: true, canManageSlack: true, canOpenInSlack: true },
  });
  const container = await render(agent, { listAgentSlackInstalls: installs([row()]) });
  expect(container.textContent).toContain("Slack · Acme");
  expect(container.querySelector("[data-agent-slack-handle]")?.textContent).toBe(
    "@Opengeni Data team",
  );
  expect(container.querySelector("[role='switch'][aria-label='Available in Acme']")).toBeNull();
  // Who can use it, including anyone in the organization, is the agent's own setting.
  expect(container.querySelector("[role='switch']")).toBeNull();
  expect(container.textContent).not.toContain(SLACK_AGENT_OPEN_LABEL);
  expect(container.textContent).toContain("Introduce in channels");
});

test("people ask it by the Opengeni app's name in that Slack workspace", async () => {
  const agent = makeAgent({ name: "Release Scribe", slack: [availability()] });
  const container = await render(agent, {
    listAgentSlackInstalls: installs([row({ botDisplayName: "Opengeni Staging" })]),
  });
  expect(container.querySelector("[data-agent-slack-handle]")?.textContent).toBe(
    "@Opengeni Staging Release Scribe",
  );
});

test("introducing it in channels goes to that Slack workspace", async () => {
  const agent = makeAgent({
    slack: [availability()],
    viewer: { canEdit: true, canManageSlack: true, canOpenInSlack: false },
  });
  let introduced = "";
  const container = await render(
    agent,
    { listAgentSlackInstalls: installs([row()]) },
    (id) => (introduced = id),
  );
  const introduce = [...container.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === "Introduce",
  )!;
  await act(async () => introduce.click());
  expect(introduced).toBe(CONNECTION_ID);
});

test("a row says why the agent isn't in that Slack workspace", async () => {
  const agent = makeAgent({ name: "Data team" });
  const container = await render(agent, {
    listAgentSlackInstalls: installs([
      row({ availability: null, unavailable: "agent_slack_name_taken" }),
    ]),
  });
  expect(container.textContent).toContain(
    "Another agent here is already called “Data team”. Rename this one to use it in Slack.",
  );
  expect(container.textContent).not.toContain(SLACK_AGENT_OPEN_LABEL);
  await cleanup?.();

  const privateAgent = makeAgent({ visibility: "private" });
  const privateRow = await render(privateAgent, {
    listAgentSlackInstalls: installs([
      row({ availability: null, unavailable: "agent_slack_requires_workspace_visibility" }),
      row({
        connectionId: "66666666-6666-4666-8666-666666666666",
        slackTeamName: "Acme Support",
        availability: null,
        unavailable: "agent_slack_requires_workspace_visibility",
      }),
    ]),
  });
  // Said once, not once per Slack workspace.
  expect(privateRow.textContent?.split("Only me agents stay in the app.").length).toBe(2);
  await cleanup?.();

  const invalid = await render(makeAgent({ name: "X" }), {
    listAgentSlackInstalls: installs([
      row({ availability: null, unavailable: "agent_slack_name_invalid" }),
    ]),
  });
  expect(invalid.textContent).toContain("Rename it to use it in Slack.");
  expect(
    agentSlackErrorText(
      { details: { code: "agent_slack_name_invalid", problem: "too_short" } },
      "X",
    ),
  ).toBe("Use at least two letters. Rename it first.");
});

test("without a connected Slack workspace, admins get one way to connect it", async () => {
  const container = await render(makeAgent(), {
    listAgentSlackInstalls: async () => ({ installs: [], routingEnabled: true }),
  });
  expect(container.textContent).toContain("No Slack workspace is connected here.");
  expect(container.textContent).toContain("Connect Slack");
});

test("it is available in every linked Slack workspace at once, with nothing to move", async () => {
  const other = "cccccccc-cccc-4ccc-8ccc-000000000002";
  const agent = makeAgent({
    name: "Data team",
    slack: [availability(), availability({ connectionId: other, slackTeamName: "Acme Support" })],
    viewer: { canEdit: true, canManageSlack: true, canOpenInSlack: false },
  });
  const container = await render(agent, {
    listAgentSlackInstalls: installs([
      row(),
      row({
        connectionId: other,
        slackTeamId: "T2",
        slackTeamName: "Acme Support",
        availability: availability({ connectionId: other, slackTeamName: "Acme Support" }),
      }),
    ]),
  });
  expect(container.textContent).toContain("Slack · Acme");
  expect(container.textContent).toContain("Slack · Acme Support");
  expect(container.querySelectorAll("[data-agent-slack-handle]")).toHaveLength(2);
  expect(container.textContent).not.toContain("Move here");
  expect(container.textContent).not.toContain("one Slack workspace");
});
