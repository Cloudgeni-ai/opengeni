import { afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { OpenGeniApiError, type OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { OrganizationRecoverySection } from "./organization-recovery";
import type { OrganizationAdminIdentity } from "@/lib/organization-admin";
import type { OrganizationRecoveryOverview } from "@/types";

beforeAll(() => {
  try {
    GlobalRegistrator.register();
  } catch {
    /* Already registered by another web test. */
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
});
const identity: OrganizationAdminIdentity = {
  principalGeneration: 1,
  subjectId: "member",
  organizationId: "org",
  workspaceId: "workspace",
};
const unavailable = () =>
  new OpenGeniApiError(
    404,
    JSON.stringify({
      code: "not_found",
      message: "Organization recovery not found.",
    }),
  );
const ownerOverview: OrganizationRecoveryOverview = {
  organizationId: "org",
  availability: "recovery_unavailable",
  unavailableReason: "no_policy",
  recentReauthenticationAt: null,
  eligibleMembers: [],
  policy: null,
  operation: null,
  capabilities: {
    configure: true,
    accept: false,
    disable: false,
    start: false,
    approve: false,
    cancel: false,
    execute: false,
  },
};
async function mount(read: () => Promise<OrganizationRecoveryOverview>) {
  const client = { getOrganizationRecovery: read } as unknown as OpenGeniBrowserClient;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <OrganizationRecoverySection client={client} identity={identity} managedSession />,
    ),
  );
  return { container, client };
}
test("a structured denial reveals neither policy state nor failure details and can refresh", async () => {
  let calls = 0;
  const { container } = await mount(async () => {
    if (++calls === 1) throw unavailable();
    return ownerOverview;
  });
  expect(container.textContent).toContain("Recovery is unavailable for this account.");
  expect(container.textContent).not.toContain("not found");
  expect(container.textContent).not.toContain("Policy:");
  expect(container.textContent).not.toContain("Couldn't load");
  await act(async () => container.querySelector("button")!.click());
  expect(calls).toBe(2);
  expect(container.textContent).toContain("Policy: not configured");
  expect(container.textContent).toContain("Save custody policy");
});
for (const error of [
  new OpenGeniApiError(
    500,
    JSON.stringify({ code: "internal_error", message: "Temporary failure" }),
  ),
  new OpenGeniApiError(404, "<html>Proxy route missing</html>"),
  new TypeError("Network unavailable"),
]) {
  test(`other failures keep retry: ${error.message}`, async () => {
    let calls = 0;
    const { container } = await mount(async () => {
      if (++calls === 1) throw error;
      return ownerOverview;
    });
    expect(container.textContent).toContain("Couldn't load organization recovery");
    expect(container.textContent).not.toContain("Recovery is unavailable for this account.");
    await act(async () => container.querySelector("button")!.click());
    expect(calls).toBe(2);
    expect(container.textContent).toContain("Policy: not configured");
  });
}
test("a late denial from the previous browser account cannot hide the current owner's recovery", async () => {
  let rejectOld!: (reason: Error) => void;
  let calls = 0;
  const { container, client } = await mount(() => {
    if (++calls === 1)
      return new Promise((_, reject) => {
        rejectOld = reject;
      });
    return Promise.resolve(ownerOverview);
  });
  await act(async () =>
    root!.render(
      <OrganizationRecoverySection
        client={client}
        identity={{ ...identity, subjectId: "owner", principalGeneration: 2 }}
        managedSession
      />,
    ),
  );
  await act(async () => rejectOld(unavailable()));
  expect(container.textContent).toContain("Save custody policy");
  expect(container.textContent).not.toContain("Recovery is unavailable for this account.");
});
