import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { SLACK_AGENT_OPEN_LABEL, SLACK_AGENT_OPEN_NARROWED_NOTICE } from "@opengeni/contracts";

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const kit = await import("../../../../../packages/react/test/agents-test-kit");
const { AGENT_SLACK_MOVE_RESETS, AgentSlackSection, agentSlackErrorText } =
  await import("./agent-slack-section");

const { WORKSPACE_ID, makeAgent, appContext, AgentsTestHost } = kit;
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
        <AgentSlackSection
          agent={agent}
          onAgentChange={() => undefined}
          onIntroduce={onIntroduce}
        />
      </AgentsTestHost>,
    ),
  );
  for (let index = 0; index < 3; index += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  return container;
}

const toggle = (container: HTMLElement, label: string) =>
  container.querySelector<HTMLButtonElement>(`[role='switch'][aria-label='${label}']`)!;

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
  expect(container.textContent).toContain(SLACK_AGENT_OPEN_LABEL);
  expect(container.textContent).toContain("Introduce in channels");
});

test("open use needs an organization admin and is saved at the version shown", async () => {
  const onAgent = makeAgent({
    slack: [availability()],
    viewer: { canEdit: true, canManageSlack: true, canOpenInSlack: false },
  });
  let introduced = "";
  const container = await render(
    onAgent,
    { listAgentSlackInstalls: installs([row()]) },
    (id) => (introduced = id),
  );
  expect(toggle(container, SLACK_AGENT_OPEN_LABEL).getAttribute("aria-disabled")).toBe("true");
  const introduce = [...container.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === "Introduce",
  )!;
  await act(async () => introduce.click());
  expect(introduced).toBe(CONNECTION_ID);
  expect(container.textContent).not.toContain(SLACK_AGENT_OPEN_NARROWED_NOTICE);
  await cleanup?.();

  const orgAdmin = makeAgent({
    slack: [availability()],
    viewer: { canEdit: true, canManageSlack: true, canOpenInSlack: true },
  });
  const calls: unknown[][] = [];
  const opened = await render(orgAdmin, {
    listAgentSlackInstalls: installs([row()]),
    putAgentSlackAvailability: async (...args: unknown[]) => {
      calls.push(args);
      const open = availability({ open: true, version: 4 });
      return { agent: { ...orgAdmin, slack: [open] }, availability: open };
    },
  });
  await act(async () => toggle(opened, SLACK_AGENT_OPEN_LABEL).click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(calls).toEqual([
    [WORKSPACE_ID, orgAdmin.id, CONNECTION_ID, { expectedVersion: 3, open: true }],
  ]);
  expect(opened.textContent).toContain(SLACK_AGENT_OPEN_NARROWED_NOTICE);
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

test("while it is in one Slack workspace, the other one says where it is", async () => {
  const agent = makeAgent({ name: "Data team", slack: [availability()] });
  const container = await render(agent, {
    listAgentSlackInstalls: installs([
      row(),
      row({
        connectionId: "cccccccc-cccc-4ccc-8ccc-000000000002",
        slackTeamId: "T2",
        slackTeamName: "Acme Support",
        availability: null,
        unavailable: "agent_slack_single_install",
      }),
    ]),
  });
  expect(container.textContent).toContain(
    "For now an agent works in one Slack workspace, and it's in Acme.",
  );
});

test("an admin can move it to the other Slack workspace", async () => {
  const other = "cccccccc-cccc-4ccc-8ccc-000000000002";
  const agent = makeAgent({
    name: "Data team",
    slack: [availability()],
    viewer: { canEdit: true, canManageSlack: true, canOpenInSlack: false },
  });
  let moved = false;
  const puts: unknown[] = [];
  const container = await render(agent, {
    listAgentSlackInstalls: async () => ({
      routingEnabled: true,
      installs: [
        row(moved ? { availability: null, unavailable: "agent_slack_single_install" } : {}),
        row({
          connectionId: other,
          slackTeamId: "T2",
          slackTeamName: "Acme Support",
          availability: moved
            ? availability({ connectionId: other, slackTeamName: "Acme Support" })
            : null,
          unavailable: moved ? null : "agent_slack_single_install",
        }),
      ],
    }),
    putAgentSlackAvailability: async (...args: unknown[]) => {
      puts.push(args);
      moved = true;
      return { agent, availability: availability({ connectionId: other }) };
    },
  });
  const buttons = [...container.querySelectorAll("button")].filter(
    (button) => button.textContent === "Move here",
  );
  expect(buttons).toHaveLength(1);
  // It says what moving drops before anyone presses it.
  expect(container.textContent).toContain(AGENT_SLACK_MOVE_RESETS);
  await act(async () => buttons[0]!.click());
  for (let index = 0; index < 3; index += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  expect(puts).toEqual([[WORKSPACE_ID, agent.id, other, {}]]);
  expect(container.textContent).toContain(
    "For now an agent works in one Slack workspace, and it's in Acme Support.",
  );
});

test("people who can't manage it see where it is, with no move", async () => {
  const agent = makeAgent({
    name: "Data team",
    slack: [availability()],
    viewer: { canEdit: false, canManageSlack: false, canOpenInSlack: false },
  });
  const container = await render(agent, {
    listAgentSlackInstalls: installs([
      row(),
      row({
        connectionId: "cccccccc-cccc-4ccc-8ccc-000000000002",
        slackTeamName: "Acme Support",
        availability: null,
        unavailable: "agent_slack_single_install",
      }),
    ]),
  });
  expect(container.textContent).not.toContain("Move here");
});
