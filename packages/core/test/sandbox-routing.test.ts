import { describe, expect, test, spyOn } from "bun:test";
import * as dbModule from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { RoutingActiveRouteChangedError } from "@opengeni/runtime/sandbox";
import {
  directRetainedProcessBackgroundCommand,
  directRetainedProcessMatchesBackend,
  retainedProcessBackgroundSettlement,
  wrapChannelABoxWithRouting,
} from "../src/sandbox/routing";
import {
  managedSessionGroupBackend,
  managedSessionGroupOs,
  sessionGroupMachinePresentation,
} from "../src/sandbox/runtime-settings";

test("placement-bound viewer setup rejects a machine pointer even when hot-swap is disabled", async () => {
  const read = spyOn(dbModule, "readActiveSandbox").mockResolvedValue({
    activeSandboxId: "machine-1",
    activeEpoch: 7,
  } as never);
  let invoked = 0;
  try {
    const handle = wrapChannelABoxWithRouting(
      {
        db: {} as never,
        settings: testSettings({ sandboxSelfhostedEnabled: false }),
      },
      {
        accountId: "account",
        workspaceId: "workspace",
        sessionId: "session",
        resourceSubjectId: "human",
        homeOnly: true,
        homeLease: {
          sandboxGroupId: "group",
          leaseEpoch: 2,
          instanceId: "sb-home",
          backend: "modal",
        },
        directRequest: { requestId: "request", holderId: "holder" },
      },
      {
        session: {
          pathExists: async () => {
            invoked++;
            return true;
          },
        },
        backendId: "modal",
        instanceId: "sb-home",
        client: {},
        sessionState: {},
      },
    );
    await expect(
      (handle.session as { pathExists(path: string): Promise<boolean> }).pathExists("/workspace"),
    ).rejects.toBeInstanceOf(RoutingActiveRouteChangedError);
    expect(invoked).toBe(0);
    expect(read).toHaveBeenCalledWith(expect.anything(), "workspace", "session");
  } finally {
    read.mockRestore();
  }
});

describe("managed session-group backend", () => {
  test("uses the deployment provider only for an explicit machine-home fallback", () => {
    expect(managedSessionGroupBackend("modal", "selfhosted")).toBe("modal");
    expect(managedSessionGroupBackend("opensandbox", "selfhosted")).toBe("opensandbox");
    expect(managedSessionGroupBackend("local", "modal")).toBe("modal");
    expect(managedSessionGroupBackend("modal", "none")).toBeNull();
    expect(managedSessionGroupBackend("none", "selfhosted")).toBeNull();
    expect(managedSessionGroupBackend("selfhosted", "selfhosted")).toBeNull();
    expect(managedSessionGroupOs("selfhosted", "macos")).toBe("linux");
    expect(managedSessionGroupOs("modal", "windows")).toBe("windows");
  });

  test("names the session box after its real provider", () => {
    expect(sessionGroupMachinePresentation("local")).toEqual({
      name: "this computer",
      kind: "local",
    });
    expect(sessionGroupMachinePresentation("docker")).toEqual({
      name: "Docker",
      kind: "docker",
    });
    expect(sessionGroupMachinePresentation("modal")).toEqual({
      name: "Modal",
      kind: "modal",
    });
  });
});

describe("API-direct retained-process route identity", () => {
  test("keeps inline synchronous filesystem processes out of session background commands", () => {
    expect(
      directRetainedProcessBackgroundCommand(
        { id: "inline-process" },
        "exec",
        "synchronous_filesystem",
      ),
    ).toBeUndefined();

    expect(directRetainedProcessBackgroundCommand({ id: "visible-process" }, "exec")).toEqual({
      commandId: "visible-process",
      command: "exec",
    });
  });

  test("accepts the default active pointer without misclassifying it as a home route", () => {
    const process = { id: "process-id", providerSessionId: 7 };
    const backend = {
      session: {},
      sandboxId: null,
      kind: "modal",
      leaseEpoch: 3,
      providerInstanceId: "modal-instance",
      activeEpoch: 0,
    };

    expect(
      directRetainedProcessMatchesBackend(
        {
          providerSessionId: 7,
          providerBackend: "modal",
          providerInstanceId: "modal-instance",
          leaseEpoch: 3,
          routeKind: "active",
          routeTargetId: null,
          routeEpoch: 0,
        },
        process,
        backend,
      ),
    ).toBe(true);

    expect(
      directRetainedProcessMatchesBackend(
        {
          providerSessionId: 7,
          providerBackend: "modal",
          providerInstanceId: "modal-instance",
          leaseEpoch: 3,
          routeKind: "home",
          routeTargetId: null,
          routeEpoch: 0,
        },
        process,
        backend,
      ),
    ).toBe(false);
  });

  test("propagates the first durable terminal reason to background-command settlement", () => {
    expect(
      retainedProcessBackgroundSettlement(
        {
          state: "lost",
          exitCode: null,
          settlementReason: "provider_instance_not_found",
        },
        {
          outcome: "lost",
          exitCode: null,
          reason: "provider_session_lost_banner",
        },
      ),
    ).toEqual({
      outcome: "lost",
      exitCode: null,
      reason: "provider_instance_not_found",
    });
  });

  test("rejects an impossible active process returned from terminal settlement", () => {
    expect(() =>
      retainedProcessBackgroundSettlement(
        { state: "active", exitCode: null, settlementReason: null },
        {
          outcome: "lost",
          exitCode: null,
          reason: "provider_session_lost_banner",
        },
      ),
    ).toThrow("active durable process");
  });
});
