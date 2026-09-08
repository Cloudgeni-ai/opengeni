import { expect, test } from "bun:test";
import { actRun, registerDom, renderComponent } from "./render-hook";
import {
  IdentityLinkAccounts,
  type IdentityLinkAccountsClient,
} from "../src/identity-link-accounts";
import type { ExternalIdentityLink } from "@opengeni/contracts/external-identities";
registerDom();
test("participant inventory paginates and revokes the observed revision without a challenge", async () => {
  const link: ExternalIdentityLink = {
    id: crypto.randomUUID(),
    accountId: crypto.randomUUID(),
    externalIdentityId: crypto.randomUUID(),
    externalIdentity: { source: "Acme", externalId: "acme-user-123" },
    nativeSubjectId: "user:fixture",
    status: "active",
    revision: 2,
    permissions: ["sessions:read"],
    expiresAt: null,
  };
  const second = { ...link, id: crypto.randomUUID(), status: "expired" as const };
  const calls: (string | undefined)[] = [];
  const client: IdentityLinkAccountsClient = {
    listIdentityLinks: async (workspace, cursor) => {
      expect(workspace).toBe("workspace");
      calls.push(cursor);
      return cursor
        ? { links: [second], nextCursor: null }
        : { links: [link], nextCursor: link.id };
    },
    revokeIdentityLink: async (workspace, id, revision) => {
      expect([workspace, id, revision]).toEqual(["workspace", link.id, 2]);
      return { ...link, status: "revoked", revision: 3 };
    },
  };
  const view = await renderComponent(
    <IdentityLinkAccounts client={client} workspaceId="workspace" />,
  );
  try {
    expect(view.container.textContent).toContain("Acme");
    expect(view.container.textContent).toContain("acme-user-123");
    expect(view.container.textContent).not.toContain(link.externalIdentityId);
    const button = (text: string) =>
      [...view.container.querySelectorAll<HTMLButtonElement>("button")].find(
        (value) => value.textContent === text,
      )!;
    await actRun(() => button("Load more links").click());
    expect(calls).toEqual([undefined, link.id]);
    expect(view.container.querySelectorAll("li")).toHaveLength(2);
    expect(view.container.querySelectorAll("button")).toHaveLength(1);
    await actRun(() => button("Revoke access").click());
    expect(view.container.textContent).toContain("Status: revoked");
    expect(view.container.querySelectorAll("button")).toHaveLength(0);
  } finally {
    await view.unmount();
  }
});

test("inventory has a truthful retry and empty state", async () => {
  let failed = true;
  const client: IdentityLinkAccountsClient = {
    listIdentityLinks: async () => {
      if (failed) throw new Error("fixture");
      return { links: [], nextCursor: null };
    },
    revokeIdentityLink: async () => {
      throw new Error("must not revoke");
    },
  };
  const view = await renderComponent(
    <IdentityLinkAccounts client={client} workspaceId="workspace" />,
  );
  try {
    expect(view.container.querySelector('[role="alert"]')).not.toBeNull();
    expect(view.container.textContent).not.toContain("No products");
    failed = false;
    await actRun(() => view.container.querySelector<HTMLButtonElement>("button")!.click());
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(view.container.textContent).toContain("No products have linked access");
  } finally {
    await view.unmount();
  }
});
