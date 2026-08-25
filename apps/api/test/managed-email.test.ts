import { describe, expect, test } from "bun:test";

import { InMemoryManagedEmailTransport } from "../src/auth/managed-email";
import {
  organizationUserSetupPayloadDigest,
  renderOrganizationUserSetupEmail,
} from "../src/auth/organization-user-setup";

const message = {
  kind: "organization_user_setup" as const,
  to: "invited@example.test",
  subject: "Invitation",
  text: "Set up with bearer-only-link",
  html: "<p>Set up with bearer-only-link</p>",
  idempotencyKey: "stable-provider-key",
};

describe("managed email transport", () => {
  test("keeps local captures bounded, TTL-limited, and one-time readable", async () => {
    let now = 0;
    const transport = new InMemoryManagedEmailTransport({
      maxMessages: 2,
      ttlMs: 100,
      now: () => now,
    });
    await transport.send({ ...message, to: "first@example.test" });
    now = 1;
    await transport.send({ ...message, to: "second@example.test" });
    now = 2;
    await transport.send({ ...message, to: "third@example.test" });
    expect(transport.size()).toBe(2);
    expect(transport.take((capture) => capture.to === "first@example.test")).toBeNull();
    expect(transport.take((capture) => capture.to === "second@example.test")).toMatchObject({
      to: "second@example.test",
      idempotencyKey: "stable-provider-key",
    });
    expect(transport.take((capture) => capture.to === "second@example.test")).toBeNull();
    expect(transport.size()).toBe(1);
    now = 102;
    expect(transport.size()).toBe(0);
  });

  test("renders an escaped, frozen safe snapshot with a stable payload digest", async () => {
    const rendered = renderOrganizationUserSetupEmail({
      recipientEmail: "invited@example.test",
      recipientName: "Ada <Admin>",
      organizationName: "R&D <Labs>",
      organizationRole: "admin",
      sharedWorkspaceAccess: [
        {
          workspaceId: crypto.randomUUID(),
          workspaceName: "Launch <Ops>",
          role: "viewer",
        },
      ],
      setupUrl: "https://opengeni.test/setup-account#token=secret-bearer",
    });
    expect(rendered.text).toContain("Ada <Admin>");
    expect(rendered.text).toContain("Launch <Ops>: Viewer");
    expect(rendered.text).toContain("never shares anyone's Personal workspace");
    expect(rendered.html).toContain("Ada &lt;Admin&gt;");
    expect(rendered.html).toContain("R&amp;D &lt;Labs&gt;");
    expect(rendered.html).toContain("Launch &lt;Ops&gt;");
    expect(rendered.html).not.toContain("Ada <Admin>");
    const first = await organizationUserSetupPayloadDigest(rendered);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await organizationUserSetupPayloadDigest(rendered)).toBe(first);
    expect(
      await organizationUserSetupPayloadDigest({
        ...rendered,
        subject: `${rendered.subject}!`,
      }),
    ).not.toBe(first);
  });
});
