import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Session } from "@opengeni/sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { admissionRecheckControl, SessionAdmissionNotice } from "./session-admission-notice";

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
    expect(wiring).toContain("const control = admissionControl");
    expect(wiring).toContain('if (control.state === "paused") return');
    expect(wiring).toContain("props.onReloadSession()");
    expect(wiring).not.toContain("asUser");
    expect(wiring).not.toContain("grant");
  });
});
