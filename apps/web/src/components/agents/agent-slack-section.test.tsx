import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const kit = await import("../../../../../packages/react/test/agents-test-kit");
const { AgentSlackSection, agentSlackErrorText } = await import("./agent-slack-section");

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

test("turning Slack on shows the handle people ask it with", async () => {
  const agent = makeAgent({ name: "Data team" });
  const calls: unknown[][] = [];
  const client = {
    listAgentSlackInstalls: async () => ({
      installs: [
        {
          connectionId: CONNECTION_ID,
          slackTeamId: "T1",
          slackTeamName: "Acme",
          availability: null,
        },
      ],
      routingEnabled: true,
    }),
    putAgentSlackAvailability: async (...args: unknown[]) => {
      calls.push(args);
      return { agent: { ...agent, slack: [availability()] }, availability: availability() };
    },
  };
  const container = await render(agent, client);
  expect(container.textContent).toContain("Slack · Acme");
  expect(container.textContent).toContain("Off");
  await act(async () => toggle(container, "Available in Acme").click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(calls).toEqual([[WORKSPACE_ID, agent.id, CONNECTION_ID, {}]]);
  expect(container.querySelector("[data-agent-slack-handle]")?.textContent).toBe(
    "@Opengeni +data-team",
  );
  expect(container.textContent).toContain("Anyone in Slack can use this agent");
  expect(container.textContent).toContain("Introduce in channels");
});

test("a name Slack can't take says why, next to the switch", async () => {
  const agent = makeAgent({ name: "Data team" });
  const client = {
    listAgentSlackInstalls: async () => ({
      installs: [
        {
          connectionId: CONNECTION_ID,
          slackTeamId: "T1",
          slackTeamName: "Acme",
          availability: null,
        },
      ],
      routingEnabled: true,
    }),
    putAgentSlackAvailability: async () => {
      throw Object.assign(new Error("Conflict"), { details: { code: "agent_slack_name_taken" } });
    },
  };
  const container = await render(agent, client);
  await act(async () => toggle(container, "Available in Acme").click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(container.textContent).toContain(
    "Another agent in this Slack workspace is called “Data team”. Rename this one first.",
  );
  expect(
    agentSlackErrorText(
      { details: { code: "agent_slack_name_invalid", problem: "too_short" } },
      "X",
    ),
  ).toBe("Use at least two letters. Rename it first.");
});

test("open use needs an organization admin; Only me agents can't be turned on", async () => {
  const onAgent = makeAgent({
    slack: [availability()],
    viewer: { canEdit: true, canManageSlack: true, canOpenInSlack: false },
  });
  const client = {
    listAgentSlackInstalls: async () => ({
      installs: [
        {
          connectionId: CONNECTION_ID,
          slackTeamId: "T1",
          slackTeamName: "Acme",
          availability: availability(),
        },
      ],
      routingEnabled: true,
    }),
  };
  let introduced = "";
  const container = await render(onAgent, client, (id) => (introduced = id));
  expect(
    toggle(container, "Anyone in Slack can use this agent").getAttribute("aria-disabled"),
  ).toBe("true");
  const introduce = [...container.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === "Introduce",
  )!;
  await act(async () => introduce.click());
  expect(introduced).toBe(CONNECTION_ID);
  await cleanup?.();

  const privateAgent = makeAgent({ visibility: "private" });
  const offClient = {
    listAgentSlackInstalls: async () => ({
      installs: [
        {
          connectionId: CONNECTION_ID,
          slackTeamId: "T1",
          slackTeamName: "Acme",
          availability: null,
        },
      ],
      routingEnabled: true,
    }),
  };
  const second = await render(privateAgent, offClient);
  expect(toggle(second, "Available in Acme").getAttribute("aria-disabled")).toBe("true");
});

test("without a connected Slack workspace, admins get one way to connect it", async () => {
  const container = await render(makeAgent(), {
    listAgentSlackInstalls: async () => ({ installs: [], routingEnabled: true }),
  });
  expect(container.textContent).toContain("No Slack workspace is connected here.");
  expect(container.textContent).toContain("Connect Slack");
});
