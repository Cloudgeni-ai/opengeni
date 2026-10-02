import { describe, expect, test } from "bun:test";
import { ANALYTICS_ACTIONS } from "./analytics-actions";
import {
  journeyAction,
  journeyMilestone,
  journeyMilestoneProperties,
  journeyOperation,
  journeyOutcome,
  journeyPage,
} from "./analytics-journey";
import { LEGACY_ORGANIZATION_SECTIONS, ORGANIZATION_ADMIN_SECTIONS } from "./organization-admin";
import { WORKSPACE_SETTINGS_SECTIONS } from "./workspace-management-location";

const workspace = "11111111-1111-4111-8111-111111111111";
const session = "22222222-2222-4222-8222-222222222222";

describe("content-free customer journey", () => {
  test("settings navigation retains the section without query content", () => {
    expect(
      journeyPage(
        `/workspaces/${workspace}/settings`,
        "?section=models&token=private&email=private",
      ),
    ).toEqual({ page: "settings", workspace_id: workspace, section: "models" });
    expect(journeyPage(`/workspaces/${workspace}/settings`, "?section=private")).toEqual({
      page: "settings",
      workspace_id: workspace,
    });
    expect(journeyPage("/reset-password/private", "?token=private")).toEqual({ page: "other" });
  });
  test("labels every workspace page, including agents, variable sets, and environments", () => {
    for (const page of [
      "agents",
      "variable-sets",
      "environments",
      "rigs",
      "capabilities",
      "plugins",
    ]) {
      expect(journeyPage(`/workspaces/${workspace}/${page}`)).toEqual({
        page,
        workspace_id: workspace,
      });
    }
    // A rig detail page reports the page, never the rig id.
    expect(journeyPage(`/workspaces/${workspace}/rigs/${session}`)).toEqual({
      page: "rigs",
      workspace_id: workspace,
    });
    expect(journeyPage(`/workspaces/${workspace}/unknown-page`)).toEqual({
      page: "other",
      workspace_id: workspace,
    });
  });

  test("labels sign-in, setup, and other top-level pages by exact path only", () => {
    expect(journeyPage("/")).toEqual({ page: "home" });
    expect(journeyPage("/setup-account", "?token=private")).toEqual({ page: "setup-account" });
    expect(journeyPage("/account-auth", "?transaction=private")).toEqual({
      page: "account-auth",
    });
    expect(journeyPage("/device", "?user_code=PRIVATE")).toEqual({ page: "device" });
    expect(journeyPage("/reset-password", "?token=private")).toEqual({ page: "reset-password" });
    expect(journeyPage("/billing", "?checkout=success")).toEqual({ page: "checkout-return" });
    expect(journeyPage("/integrations")).toEqual({ page: "integration-return" });
    expect(journeyPage("/settings/security")).toEqual({ page: "personal-security" });
    // Ids in top-level paths are never reported.
    expect(journeyPage(`/sessions/${session}`)).toEqual({ page: "session-link" });
    expect(journeyPage(`/identity-links/${session}`)).toEqual({ page: "identity-link" });
    for (const path of ["/device/extra", "/workspaces", "/private-page", "/sessions"]) {
      expect(journeyPage(path)).toEqual({ page: "other" });
    }
  });

  test("keeps settings, organization, and state sections from the closed list", () => {
    for (const [path, section] of [
      ["settings", "learning"],
      ["settings", "plugins"],
      ["settings", "danger"],
      ["organization", "overview"],
      ["organization", "people"],
      ["organization", "recovery"],
      ["organization", "developer"],
    ] as const) {
      expect(journeyPage(`/workspaces/${workspace}/${path}`, `?section=${section}`)).toEqual({
        page: path,
        workspace_id: workspace,
        section,
      });
    }
    expect(journeyPage(`/workspaces/${workspace}/state`, "?view=files&file=private")).toEqual({
      page: "state",
      workspace_id: workspace,
      section: "files",
    });
  });

  test("every settings and organization section the app links to has a label", () => {
    const pages = [
      ...[
        ...WORKSPACE_SETTINGS_SECTIONS,
        // Older workspace `?section=` values that still resolve.
        "members",
        "danger",
        "plugins",
        "capabilities",
      ].map((section) => ["settings", section] as const),
      ...[...ORGANIZATION_ADMIN_SECTIONS, ...Object.keys(LEGACY_ORGANIZATION_SECTIONS)].map(
        (section) => ["organization", section] as const,
      ),
    ];
    for (const [path, section] of pages) {
      expect(journeyPage(`/workspaces/${workspace}/${path}`, `?section=${section}`).section).toBe(
        section,
      );
    }
  });

  test("accepts only the closed control action labels", () => {
    for (const action of ANALYTICS_ACTIONS) expect(journeyAction(action)).toBe(action);
    expect(ANALYTICS_ACTIONS).toEqual(
      expect.arrayContaining([
        "new_session",
        "send",
        "steer",
        "pause",
        "connect_integration",
        "create_schedule",
        "install_skill",
        "invite_member",
        "buy_credits",
        "connect_model",
      ]),
    );
    for (const value of [null, "", "Buy credits", "send message", "connect_codex "]) {
      expect(journeyAction(value)).toBeNull();
    }
  });

  test("every app route has a page label", async () => {
    const app = await Bun.file(`${import.meta.dir}/../App.tsx`).text();
    const routes = Array.from(
      app.matchAll(
        /createRoute\(\{\s*getParentRoute: \(\) => (rootRoute|workspaceRoute),\s*path: "([^"]*)"/g,
      ),
      (match) => ({ parent: match[1]!, path: match[2]! }),
    );
    expect(routes.length).toBeGreaterThan(30);
    // Legacy redirects and DEV-only harnesses intentionally stay "other".
    const unlabeled = new Set(["workspaceRoute:agent", "workspaceRoute:account"]);
    const concrete = (path: string) => path.replace(/\$\w+/g, session);
    const missing = routes.filter(({ parent, path }) => {
      if (unlabeled.has(`${parent}:${path}`) || path.startsWith("dev/")) return false;
      if (parent === "rootRoute" && path === "workspaces/$workspaceId") return false;
      const pathname =
        parent === "workspaceRoute"
          ? `/workspaces/${workspace}/${concrete(path).replace(/^\/$/, "")}`
          : `/${concrete(path).replace(/^\/$/, "")}`;
      return journeyPage(pathname).page === "other";
    });
    expect(missing).toEqual([]);
  });

  test("tracks starts and existing-session commands without inspecting content", () => {
    expect(journeyOperation(`/v1/workspaces/${workspace}/sessions`, "POST")?.operation).toBe(
      "session_create",
    );
    expect(
      journeyOperation(`/v1/workspaces/${workspace}/sessions/${session}/events`, "POST"),
    ).toEqual({
      operation: "session_command",
      properties: { workspace_id: workspace, session_id: session, method: "POST" },
    });
    expect(
      journeyOperation(
        `/v1/workspaces/${workspace}/sessions/${session}/composer-draft/submit`,
        "POST",
      )?.operation,
    ).toBe("session_command");
    expect(
      journeyOperation(`/v1/workspaces/${workspace}/sessions/${session}/events/stream`, "GET"),
    ).toBeNull();
    expect(journeyOperation("/v1/auth/sign-in/email", "POST")).toBeNull();
    expect(journeyOperation(`/v1/workspaces/${workspace}/secrets`, "POST")).toBeNull();
  });
  test("connection polling is not counted as a new attempt", () => {
    expect(
      journeyOperation(`/v1/workspaces/${workspace}/codex/connect/start`, "POST")?.operation,
    ).toBe("model_connection");
    expect(journeyOperation(`/v1/workspaces/${workspace}/codex/connect/poll`, "POST")).toBeNull();
  });
  test("distinguishes rejected admission from accepted requests", () => {
    expect(journeyOutcome(201)).toBe("accepted");
    expect(journeyOutcome(422)).toBe("invalid_request");
    expect(journeyOutcome(402)).toBe("credits_required");
    expect(journeyOutcome(503)).toBe("server_error");
  });

  test("funnel milestones are exact accepted-route facts", () => {
    expect(journeyMilestone("/v1/billing/checkout", "POST")).toBe("checkout_started");
    expect(journeyMilestone("/v1/billing/checkout", "post")).toBe("checkout_started");
    expect(journeyMilestone("/v1/auth/organization-onboarding", "POST")).toBe(
      "organization_setup_completed",
    );
    expect(journeyMilestone("/v1/auth/organization-onboarding", "GET")).toBeNull();
    expect(journeyMilestone("/v1/billing/checkout/extra", "POST")).toBeNull();
    expect(journeyMilestone("/v1/billing/usage-summary", "POST")).toBeNull();
  });

  test("first-run success milestones: an organization API key and a schedule, by exact route", () => {
    const organization = "33333333-3333-4333-8333-333333333333";
    expect(journeyMilestone(`/v1/organizations/${organization}/api-keys`, "POST")).toBe(
      "api_key_created",
    );
    expect(journeyMilestone(`/v1/workspaces/${workspace}/scheduled-tasks`, "POST")).toBe(
      "schedule_created",
    );
    expect(journeyMilestoneProperties(`/v1/organizations/${organization}/api-keys`)).toEqual({
      account_id: organization,
    });
    expect(journeyMilestoneProperties(`/v1/workspaces/${workspace}/scheduled-tasks`)).toEqual({
      workspace_id: workspace,
    });
    // Listing, revoking, and running are not creations; ids must be real UUIDs.
    expect(journeyMilestone(`/v1/organizations/${organization}/api-keys`, "GET")).toBeNull();
    expect(journeyMilestone(`/v1/organizations/${organization}/api-keys/key`, "DELETE")).toBeNull();
    expect(
      journeyMilestone(`/v1/workspaces/${workspace}/scheduled-tasks/${session}/trigger`, "POST"),
    ).toBeNull();
    expect(journeyMilestone("/v1/organizations/not-a-uuid/api-keys", "POST")).toBeNull();
  });

  test("labels the Get started page and the playground", () => {
    expect(journeyPage(`/workspaces/${workspace}/get-started`, "?step=product")).toEqual({
      page: "get-started",
      workspace_id: workspace,
    });
    expect(journeyPage(`/workspaces/${workspace}/playground`)).toEqual({
      page: "playground",
      workspace_id: workspace,
    });
  });
});
