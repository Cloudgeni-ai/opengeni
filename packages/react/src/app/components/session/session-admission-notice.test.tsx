import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Session } from "@opengeni/sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  admissionRecheckControl,
  admissionControlNeedsRefresh,
  recheckSessionAdmission,
  SessionAdmissionNotice,
} from "./session-admission-notice";

beforeAll(() => {
  if (!globalThis.document) GlobalRegistrator.register();
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | undefined;
let container: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
});

function session(reason = "database_claim_rejected", status = "requires_action") {
  return {
    id: "session-a",
    workspaceId: "workspace-a",
    status,
    admissionBlock: {
      reason,
      sqlState: "42501",
      retryPolicy: "explicit_recheck",
      blockedAt: "2026-09-18T12:00:00Z",
    },
  } as unknown as Session;
}

async function render(overrides: Partial<Parameters<typeof SessionAdmissionNotice>[0]> = {}) {
  const onRecheck = mock(async () => {});
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <SessionAdmissionNotice
        session={session()}
        canControl
        paused={false}
        busy={false}
        onRecheck={onRecheck}
        {...overrides}
      />,
    );
  });
  return onRecheck;
}

describe("session admission notice", () => {
  test("a confirmed pointer change offers recheck without claiming the saved message ran", async () => {
    const onRecheck = await render({
      session: { ...session(), activeSandboxId: "machine" },
      machineAccess: {
        sandboxId: "machine",
        machineName: "Build box",
        ownerName: "Alex",
        isOwner: false,
        queuedTurnBlocked: true,
      },
    });
    await act(async () =>
      root!.render(
        <SessionAdmissionNotice
          session={{ ...session(), activeSandboxId: "workspace-machine" }}
          canControl
          paused={false}
          busy={false}
          machineAccess={null}
          onRecheck={onRecheck}
        />,
      ),
    );
    expect(container.textContent).toContain("Machine changed");
    expect(container.textContent).toContain("The saved message has not started yet");
    expect(container.querySelector("button")?.disabled).toBe(false);
    expect(onRecheck).not.toHaveBeenCalled();
  });
  test("known owner mismatch names the machine and disables a futile recheck", async () => {
    const onRecheck = await render({
      machineAccess: {
        sandboxId: "machine",
        machineName: "Build box",
        ownerName: "Alex",
        isOwner: false,
        queuedTurnBlocked: true,
      },
      machineAction: <button>Choose machine</button>,
    });
    expect(container.textContent).toContain("This message needs a different machine");
    expect(container.textContent).toContain("Alex’s personal machine");
    expect(container.textContent).toContain("The queued message is saved");
    const recheck = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Recheck access",
    )!;
    expect(recheck.disabled).toBe(true);
    await act(async () => recheck.click());
    expect(onRecheck).not.toHaveBeenCalled();
  });

  test("machine owner sees why somebody else's queued message cannot start", async () => {
    await render({
      machineAccess: {
        sandboxId: "machine",
        machineName: "Build box",
        ownerName: "Alex",
        isOwner: true,
        queuedTurnBlocked: true,
      },
    });
    expect(container.textContent).toContain("your personal machine");
    expect(container.textContent).toContain("Messages from other people cannot start");
    expect(container.textContent).toContain("ask a workspace admin to share this machine");
    expect(container.textContent).not.toContain("Copy request");
  });

  test("a new machine or a non-permission failure retains ordinary recheck guidance", async () => {
    await render({
      machineAccess: {
        sandboxId: "new-machine",
        machineName: "My machine",
        ownerName: "Sam",
        isOwner: true,
        queuedTurnBlocked: false,
      },
    });
    expect(container.textContent).not.toContain("This message needs a different machine");
    expect(container.querySelector("button")?.disabled).toBe(false);
  });

  function control(state: "active" | "paused", version: number) {
    return {
      state,
      controlVersion: version,
      controlEtag: `${state}-${version}`,
    } as Session["effectiveControl"];
  }

  test("newer external pause wins over stale queue and composer snapshots", () => {
    const paused = control("paused", 3);
    expect(admissionRecheckControl(paused, control("active", 1), control("active", 2))).toBe(
      paused,
    );
    expect(admissionRecheckControl(control("active", 1), paused, control("active", 2))).toBe(
      paused,
    );
  });

  test("newer mutation receipt wins and equal versions preserve a known pause", () => {
    const active = control("active", 4);
    expect(admissionRecheckControl(control("paused", 3), null, active)).toBe(active);
    const paused = control("paused", 4);
    expect(admissionRecheckControl(paused, active, active)).toBe(paused);
    expect(admissionRecheckControl(active, paused, undefined)).toBe(paused);
  });

  test("preserves newest accepted pause with reversed response order", () => {
    const paused = control("paused", 12);
    const active = control("active", 11);
    expect(admissionRecheckControl(active, active, paused)).toBe(paused);
    expect(admissionRecheckControl(paused, active, active)).toBe(paused);
    expect(admissionRecheckControl(active, paused, active)).toBe(paused);
  });

  test("equal-version state or ETag disagreement requires read-only refresh", async () => {
    const active = control("active", 10);
    const paused = control("paused", 10);
    expect(admissionControlNeedsRefresh(paused, active)).toBe(true);
    expect(admissionControlNeedsRefresh(active, { ...active, controlEtag: "other" })).toBe(true);
    expect(admissionControlNeedsRefresh(paused, control("active", 9), paused)).toBe(false);
    const resume = mock(async () => {});
    const refresh = mock(async () => {});
    await render({
      paused: true,
      refreshRequired: true,
      onRecheck: () =>
        recheckSessionAdmission({ control: paused, refreshOnly: true, resume, refresh: [refresh] }),
    });
    expect(container.querySelector("button")?.textContent).toBe("Refresh session status");
    await act(async () => container.querySelector("button")!.click());
    expect(resume).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test("racing pause rejection refreshes both reads once without replaying Resume", async () => {
    const conflict = Object.assign(new Error("private conflict detail"), { status: 409 });
    const resume = mock(async () => {
      throw conflict;
    });
    let refreshedControl = control("active", 10);
    const detail = mock(async () => {
      refreshedControl = control("paused", 11);
    });
    const queue = mock(async () => {});
    await expect(
      recheckSessionAdmission({
        control: refreshedControl,
        refreshOnly: false,
        resume,
        refresh: [detail, queue],
      }),
    ).rejects.toBe(conflict);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(detail).toHaveBeenCalledTimes(1);
    expect(queue).toHaveBeenCalledTimes(1);
    const latest = admissionRecheckControl(refreshedControl, control("active", 10));
    await render({ paused: latest.state === "paused" });
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).not.toContain("private conflict");
  });

  test("rejected resume stays pending until both refreshes settle and keeps safe error", async () => {
    let finish!: () => void;
    const resume = mock(async () => {
      throw new Error("secret rejection");
    });
    const firstRead = mock(async () => {
      throw new Error("secret read error");
    });
    const secondRead = mock(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await render({
      onRecheck: () =>
        recheckSessionAdmission({
          control: control("active", 10),
          refreshOnly: false,
          resume,
          refresh: [firstRead, secondRead],
        }),
    });
    await act(async () => container.querySelector("button")!.click());
    expect(container.querySelector("button")!.disabled).toBe(true);
    await act(async () => finish());
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).not.toContain("secret");
    expect(resume).toHaveBeenCalledTimes(1);
    expect(firstRead).toHaveBeenCalledTimes(1);
    expect(secondRead).toHaveBeenCalledTimes(1);
  });

  test("successful recheck refreshes once; refresh failure does not retry mutation", async () => {
    const resume = mock(async () => {});
    const refresh = mock(async () => {
      throw new Error("read failed");
    });
    await expect(
      recheckSessionAdmission({
        control: control("active", 10),
        refreshOnly: false,
        resume,
        refresh: [refresh],
      }),
    ).rejects.toThrow("Session status could not be refreshed");
    expect(resume).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  for (const [reason, copy] of [
    ["database_claim_rejected", "blocked by a permission check"],
    ["initiator_membership_required", "person who started this work"],
    ["personal_resource_grant_required", "personal resource"],
    ["future_reason", "Ask a workspace admin to investigate"],
  ] as const) {
    test(`safe explanation for ${reason}`, async () => {
      const recheck = await render({ session: session(reason) });
      expect(container.textContent).toContain(copy);
      expect(container.textContent).toContain("will not retry automatically");
      expect(container.textContent).toContain("queued work is saved");
      expect(container.textContent).not.toContain("Nothing is needed from you");
      expect(container.innerHTML).not.toContain("secret-database-detail");
      expect(container.innerHTML).not.toContain("42501");
      expect(container.querySelector('[role="status"]')).not.toBeNull();
      expect(recheck).not.toHaveBeenCalled();
    });
  }

  test("permission denial explains the prerequisite before rechecking", async () => {
    await render();
    expect(container.textContent).toContain("Permission needed");
    expect(container.textContent).toContain("machine and resources");
    expect(container.textContent).toContain("After access changes");
    expect(container.querySelector("button")?.textContent).toBe("Recheck access");
  });

  for (const sqlState of ["23514", null, "42501 secret-database-detail"]) {
    test(`non-permission or malformed SQLSTATE gets honest generic recovery: ${sqlState}`, async () => {
      const value = session();
      await render({
        session: { ...value, admissionBlock: { ...value.admissionBlock!, sqlState } } as Session,
      });
      expect(container.textContent).toContain("Couldn't start");
      expect(container.textContent).toContain("Once the problem is fixed");
      expect(container.textContent).not.toContain("permission check");
      expect(container.innerHTML).not.toContain("secret-database-detail");
      expect(container.querySelector("button")?.textContent).toBe("Try again");
    });
  }

  for (const value of [undefined, null]) {
    test(`older/missing projection ${value} stays hidden`, async () => {
      await render({ session: { ...session(), admissionBlock: value } as Session });
      expect(container.textContent).toBe("");
    });
  }

  test("stale block on a running session stays hidden", async () => {
    await render({ session: session("database_claim_rejected", "running") });
    expect(container.textContent).toBe("");
  });

  test("read-only viewer gets explanation but no action", async () => {
    await render({ canControl: false });
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toContain("permission to control");
  });

  test("an explicit pause is never cleared by the notice", async () => {
    const recheck = await render({ paused: true });
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toContain("also paused");
    expect(recheck).not.toHaveBeenCalled();
  });

  test("disables during other control mutations", async () => {
    await render({ busy: true });
    expect(container.querySelector("button")!.disabled).toBe(true);
  });

  test("explicit click runs once with accessible loading and no optimistic dismissal", async () => {
    let finish!: () => void;
    const onRecheck = mock(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await render({ onRecheck });
    const button = container.querySelector("button")!;
    expect(document.getElementById(button.getAttribute("aria-describedby")!)).not.toBeNull();
    await act(async () => {
      button.click();
      button.click();
    });
    expect(onRecheck).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.textContent).toBe("Rechecking…");
    await act(async () => finish());
    expect(button.disabled).toBe(false);
    expect(container.textContent).toContain("Permission needed");
  });

  test("failure is announced without exposing server errors", async () => {
    await render({
      onRecheck: async () => {
        throw new Error("private SQL failure");
      },
    });
    await act(async () => container.querySelector("button")!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "could not be confirmed",
    );
    expect(container.textContent).not.toContain("private SQL");
    expect(container.querySelector("button")!.disabled).toBe(false);
  });

  test("route uses existing fenced Resume with no grants or pause mutation", async () => {
    const route = await Bun.file(`${import.meta.dir}/../../routes/session.tsx`).text();
    const wiring = route.slice(
      route.indexOf("<SessionAdmissionNotice"),
      route.indexOf("<SessionChrome"),
    );
    expect(wiring).toContain('workspacePermissions.includes("sessions:control")');
    expect(wiring).toContain("context.client.resumeSession");
    expect(wiring).toContain("expectedControlEtag: control.controlEtag");
    expect(wiring).toContain('paused={admissionControl.state === "paused"}');
    expect(wiring).toContain("control: admissionControl");
    expect(wiring).toContain("refreshOnly: admissionRefreshRequired");
    expect(wiring).toContain("refresh: [props.onReloadSession, props.queue.refresh]");
    expect(route).toContain(
      "admissionSessionControl={sessionSeed?.effectiveControl ?? session.effectiveControl}",
    );
    expect(route).toContain("admissionRecheckControl(\n    props.admissionSessionControl,");
    expect(wiring).not.toContain("asUser");
    expect(wiring).not.toContain("grant");
  });
});

describe("waiting updates from other people's work", () => {
  const access = (
    isOwner: boolean,
    waitingWork: { name: string | null; isYou: boolean; results: number }[],
  ) => ({
    sandboxId: "machine",
    machineName: "Alex Mac",
    ownerName: "Alex",
    isOwner,
    queuedTurnBlocked: false,
    waitingWork,
  });

  test("the owner gets one calm notice naming whose updates wait, and can continue", async () => {
    const onContinue = mock(async () => {});
    const onRecheck = await render({
      machineAccess: access(true, [{ name: "Sam", isYou: false, results: 3 }]),
      onContinueWaitingWork: onContinue,
    });
    expect(container.textContent).toContain("3 updates from Sam’s agents are waiting for you");
    expect(container.textContent).toContain("your personal machine “Alex Mac”");
    expect(container.textContent).not.toContain("Permission needed");
    expect(container.querySelectorAll("[role=alert]")).toHaveLength(0);
    const button = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Continue with them",
    )!;
    await act(async () => button.click());
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(onRecheck).not.toHaveBeenCalled();
  });

  test("it explains a running chat too, not only a blocked one", async () => {
    await render({
      session: session("database_claim_rejected", "running"),
      machineAccess: access(true, [{ name: "Sam", isYou: false, results: 1 }]),
      onContinueWaitingWork: async () => {},
    });
    expect(container.textContent).toContain("An update from Sam’s agents is waiting for you");
  });

  test("a refused continue says what to do next", async () => {
    await render({
      machineAccess: access(true, [{ name: "Sam", isYou: false, results: 2 }]),
      onContinueWaitingWork: async () => {
        throw Object.assign(new Error("conflict"), { status: 409 });
      },
    });
    const button = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Continue with them",
    )!;
    await act(async () => button.click());
    expect(container.querySelector("[role=alert]")?.textContent).toContain(
      "Send a message in this chat first",
    );
  });

  test("the person whose updates wait sees who they wait for and can ask them", async () => {
    await render({
      machineAccess: access(false, [{ name: "Sam", isYou: true, results: 2 }]),
      onContinueWaitingWork: async () => {},
    });
    expect(container.textContent).toContain("2 updates from your agents are waiting for Alex");
    expect(container.textContent).toContain("Alex can continue with them from this chat");
    // They act from the composer's notice; nothing here they cannot do.
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  test("someone else sees whose updates wait for the owner", async () => {
    await render({
      machineAccess: access(false, [
        { name: "Sam", isYou: false, results: 1 },
        { name: "Kim", isYou: false, results: 1 },
      ]),
    });
    expect(container.textContent).toContain(
      "2 updates from Sam and Kim’s agents are waiting for Alex",
    );
    expect(container.textContent).toContain("Only Alex can let the agent continue with them");
  });

  test("another kind of block keeps its own notice", async () => {
    await render({
      session: session("initiator_membership_required"),
      machineAccess: access(true, [{ name: "Sam", isYou: false, results: 1 }]),
    });
    expect(container.textContent).toContain("Workspace access needed");
  });
});
