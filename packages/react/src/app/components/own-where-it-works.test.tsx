import { afterAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { OwnResourceReachWorkspace } from "@opengeni/sdk";

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
afterAll(() => GlobalRegistrator.unregister());

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { OwnWhereItWorksCard, OwnWhereItWorksSection, ownReachHasNothingToChoose } =
  await import("./own-where-it-works");

const personal: OwnResourceReachWorkspace = {
  workspaceId: "personal",
  name: "Personal",
  personal: true,
  current: false,
  on: true,
  alwaysOn: true,
  canChange: false,
};
const team: OwnResourceReachWorkspace = {
  workspaceId: "team",
  name: "Team",
  personal: false,
  current: true,
  on: false,
  alwaysOn: false,
  canChange: true,
};
const locked: OwnResourceReachWorkspace = {
  workspaceId: "locked",
  name: "Locked",
  personal: false,
  current: false,
  on: false,
  alwaysOn: false,
  canChange: false,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function reachClient(workspaces: OwnResourceReachWorkspace[] | Error) {
  return {
    getOwnResourceReach: mock(async (_workspaceId: string, resource: { resourceId: string }) => {
      if (workspaces instanceof Error) throw workspaces;
      return { resourceKind: "connection" as const, resourceId: resource.resourceId, workspaces };
    }),
    setOwnResourceReach: mock(
      async (
        workspaceId: string,
        request: { on: boolean },
      ): Promise<{ workspace: OwnResourceReachWorkspace }> => ({
        workspace: { ...team, workspaceId, on: request.on, current: false },
      }),
    ),
  };
}

async function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  await act(async () => {});
  return {
    container,
    switches: () => [...container.querySelectorAll<HTMLButtonElement>('[role="switch"]')],
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const target = { workspaceId: "team", resourceKind: "connection" as const, resourceId: "login" };

test("lists each workspace with whether it works there, Personal first and fixed", async () => {
  const client = reachClient([personal, team, locked]);
  const view = await render(<OwnWhereItWorksSection client={client} {...target} name="Mail" />);
  expect(client.getOwnResourceReach).toHaveBeenCalledWith("team", {
    resourceKind: "connection",
    resourceId: "login",
  });
  expect(view.container.textContent).toContain("Where it works");
  expect(view.container.textContent).toContain("Only your own messages use it.");
  expect(view.container.textContent).toContain("Your Personal workspace. It always works here.");
  expect(view.container.textContent).toContain("This workspace");
  // A workspace where you can't add your own says so without hovering.
  expect(view.container.textContent).toContain("You can't add your own things here");
  const switches = view.switches();
  expect(switches.map((entry) => entry.getAttribute("aria-label"))).toEqual([
    "Use Mail in Personal",
    "Use Mail in Team",
    "Use Mail in Locked",
  ]);
  expect(switches.map((entry) => entry.getAttribute("aria-checked"))).toEqual([
    "true",
    "false",
    "false",
  ]);
  // Personal can't be turned off, and a workspace that doesn't let you add your own things says so.
  expect(switches[0]?.getAttribute("aria-disabled")).toBe("true");
  expect(switches[2]?.getAttribute("aria-disabled")).toBe("true");
  await act(async () => switches[0]?.click());
  await act(async () => switches[2]?.click());
  expect(client.setOwnResourceReach).not.toHaveBeenCalled();
  await view.unmount();
});

test("a switch moves at once and keeps the saved answer", async () => {
  const client = reachClient([personal, team]);
  const saved = deferred<{ workspace: OwnResourceReachWorkspace }>();
  client.setOwnResourceReach.mockImplementationOnce(() => saved.promise);
  const view = await render(<OwnWhereItWorksSection client={client} {...target} name="Mail" />);
  await act(async () => view.switches()[1]?.click());
  expect(client.setOwnResourceReach).toHaveBeenCalledWith("team", {
    resourceKind: "connection",
    resourceId: "login",
    on: true,
  });
  expect(view.switches()[1]?.getAttribute("aria-checked")).toBe("true");
  await act(async () => saved.resolve({ workspace: { ...team, on: true, current: false } }));
  expect(view.switches()[1]?.getAttribute("aria-checked")).toBe("true");
  // The page's own workspace is still named as this one.
  expect(view.container.textContent).toContain("This workspace");
  await view.unmount();
});

test("a failed change puts the switch back and says why", async () => {
  const client = reachClient([personal, team]);
  client.setOwnResourceReach.mockImplementationOnce(async () => {
    throw new Error("Not allowed here");
  });
  const view = await render(<OwnWhereItWorksSection client={client} {...target} name="Mail" />);
  await act(async () => view.switches()[1]?.click());
  expect(view.switches()[1]?.getAttribute("aria-checked")).toBe("false");
  expect(view.container.textContent).toContain("Not allowed here");
  await view.unmount();
});

test("shows nothing for something that isn't yours, or with nothing to choose", async () => {
  const notYours = Object.assign(new Error("Not found"), { status: 404 });
  const absent = await render(
    <OwnWhereItWorksSection client={reachClient(notYours)} {...target} name="Mail" />,
  );
  expect(absent.container.innerHTML).toBe("");
  await absent.unmount();
  const onlyPersonal = await render(
    <OwnWhereItWorksCard client={reachClient([personal])} {...target} name="Mail" />,
  );
  expect(onlyPersonal.container.innerHTML).toBe("");
  await onlyPersonal.unmount();
  expect(ownReachHasNothingToChoose([personal])).toBe(true);
  // A machine can be turned off in Personal, so even alone there is a choice.
  expect(ownReachHasNothingToChoose([{ ...personal, alwaysOn: false, canChange: true }])).toBe(
    false,
  );
});

test("loads with placeholders, and a failed load can be tried again", async () => {
  const client = reachClient([personal, team]);
  const first = deferred<never>();
  client.getOwnResourceReach.mockImplementationOnce(() => first.promise);
  const view = await render(<OwnWhereItWorksCard client={client} {...target} name="Machine" />);
  expect(view.container.querySelector('[aria-busy="true"]')).not.toBeNull();
  await act(async () => first.reject(new Error("Service unavailable")));
  expect(view.container.textContent).toContain("Couldn't load where it works");
  const retry = [...view.container.querySelectorAll("button")].find(
    (button) => button.textContent === "Try again",
  );
  await act(async () => retry?.click());
  await act(async () => {});
  expect(view.container.querySelector("[data-own-where-it-works] h2")?.textContent).toBe(
    "Where it works",
  );
  expect(view.switches()).toHaveLength(2);
  await view.unmount();
});
