import { expect, test } from "bun:test";
import { renderComponent, actRun, registerDom } from "./render-hook";
import { IdentityLinkConsent, type IdentityLinkClient } from "../src/identity-link-consent";
import type { ExternalIdentityLink } from "@opengeni/contracts/external-identities";
registerDom();

const pending: ExternalIdentityLink = {
  id: crypto.randomUUID(),
  accountId: crypto.randomUUID(),
  externalIdentityId: crypto.randomUUID(),
  nativeSubjectId: null,
  status: "pending",
  revision: 1,
  permissions: ["sessions:read", "sessions:create"],
  expiresAt: null,
};
test("link consent requires a click, narrows permissions and can revoke without exposing the challenge", async () => {
  let confirms = 0;
  let revokes = 0;
  const challenge = "x".repeat(43);
  const client: IdentityLinkClient = {
    previewIdentityLink: async () => ({
      link: pending,
      externalIdentity: { externalId: "product-user", source: "default" },
      nativeSubjectId: "user:confirmed",
      organizationId: pending.accountId,
    }),
    confirmIdentityLink: async (workspaceId, linkId, input) => {
      confirms++;
      expect(workspaceId).toBe("workspace");
      expect(linkId).toBe(pending.id);
      expect(input).toEqual({ challenge, expectedRevision: 1, permissions: ["sessions:read"] });
      return {
        ...pending,
        status: "active",
        revision: 2,
        nativeSubjectId: "user:confirmed",
        permissions: input.permissions,
      };
    },
    revokeIdentityLink: async (_workspaceId, linkId, revision) => {
      revokes++;
      expect(linkId).toBe(pending.id);
      expect(revision).toBe(2);
      return { ...pending, status: "revoked", revision: 3, nativeSubjectId: "user:confirmed" };
    },
  };
  const view = await renderComponent(
    <IdentityLinkConsent
      client={client}
      workspaceId="workspace"
      linkId={pending.id}
      challenge={challenge}
    />,
  );
  try {
    expect(confirms).toBe(0);
    expect(view.container.textContent).not.toContain(challenge);
    const boxes = view.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(boxes.length).toBe(2);
    await actRun(() => boxes[1]!.click());
    const allow = [...view.container.querySelectorAll("button")].find(
      (node) => node.textContent === "Allow selected access",
    )!;
    await actRun(() => allow.click());
    expect(confirms).toBe(1);
    expect(view.container.textContent).toContain("Account linked");
    await actRun(() => view.container.querySelector<HTMLButtonElement>("button")!.click());
    expect(revokes).toBe(1);
    expect(view.container.textContent).toContain("Link revoked");
  } finally {
    await view.unmount();
  }
});
test("expired or inaccessible consent fails closed with a recoverable error", async () => {
  const unavailable = async (): Promise<never> => {
    throw new Error("unavailable");
  };
  const client: IdentityLinkClient = {
    previewIdentityLink: unavailable,
    confirmIdentityLink: unavailable,
    revokeIdentityLink: unavailable,
  };
  const view = await renderComponent(
    <IdentityLinkConsent
      client={client}
      workspaceId="workspace"
      linkId={pending.id}
      challenge={"x".repeat(43)}
    />,
  );
  try {
    expect(view.container.querySelector('[role="alert"]')).not.toBeNull();
    expect(view.container.textContent).not.toContain("Allow selected access");
    expect(view.container.textContent).toContain("Try again");
  } finally {
    await view.unmount();
  }
});
