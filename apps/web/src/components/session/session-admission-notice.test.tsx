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
      sqlState: "42501 secret-database-detail",
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
    ["database_claim_rejected", "access or safety check"],
    ["initiator_membership_required", "person who started this work"],
    ["personal_resource_grant_required", "personal resource"],
    ["future_reason", "access or safety check"],
  ] as const) {
    test(`safe explanation for ${reason}`, async () => {
      const recheck = await render({ session: session(reason) });
      expect(container.textContent).toContain(copy);
      expect(container.textContent).toContain("will not retry automatically");
      expect(container.innerHTML).not.toContain("secret-database-detail");
      expect(container.innerHTML).not.toContain("42501");
      expect(container.querySelector('[role="status"]')).not.toBeNull();
      expect(recheck).not.toHaveBeenCalled();
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
    expect(container.textContent).toContain("Work needs attention");
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
