import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { loadRailFooterMenuHarness } from "./rail-footer-menu-harness";

const { renderOpenAccountMenu, menuSequence, openSubmenu, expectNoAdjacentSeparators, teardown } =
  await loadRailFooterMenuHarness();

afterAll(teardown);

beforeEach(() => {
  document.body.replaceChildren();
});

const docs = "https://docs.example.test/";

describe("rail footer account menu", () => {
  test("is identity, Appearance, Help & feedback, then the account action", async () => {
    const unmount = await renderOpenAccountMenu({
      managed: false,
      analytics: true,
      documentationUrl: docs,
    });
    try {
      const sequence = menuSequence();
      expectNoAdjacentSeparators(sequence);
      expect(sequence).toHaveLength(6);
      expect(sequence[1]).toBe("|");
      expect(sequence[2]).toContain("Appearance");
      expect(sequence[3]).toContain("Help & feedback");
      expect(sequence[4]).toBe("|");
      expect(sequence[5]).toContain("access");
    } finally {
      await unmount();
    }
  });

  test("keeps Settings, Personal settings and Privacy preferences out of the menu", async () => {
    const unmount = await renderOpenAccountMenu({
      managed: true,
      analytics: true,
      documentationUrl: docs,
    });
    try {
      const text = menuSequence().join("\n");
      expect(text).not.toContain("Settings");
      expect(text).not.toContain("Personal");
      expect(text).not.toContain("preferences");
      expect(text).toContain("Sign out");
    } finally {
      await unmount();
    }
  });

  test("lists Invitations, with its own separator, only while some are pending", async () => {
    const pendingUnmount = await renderOpenAccountMenu({
      managed: true,
      analytics: false,
      documentationUrl: docs,
      pendingInvitations: 2,
    });
    try {
      const sequence = menuSequence();
      expectNoAdjacentSeparators(sequence);
      expect(sequence[2]).toBe("Invitations2");
      expect(sequence[3]).toBe("|");
    } finally {
      await pendingUnmount();
    }
    document.body.replaceChildren();
    const idleUnmount = await renderOpenAccountMenu({
      managed: true,
      analytics: false,
      documentationUrl: docs,
    });
    try {
      const sequence = menuSequence();
      expectNoAdjacentSeparators(sequence);
      expect(sequence.join("|")).not.toContain("Invitations");
      expect(sequence[2]).toContain("Appearance");
    } finally {
      await idleUnmount();
    }
  });

  test("Appearance opens Light, Dark and System", async () => {
    const unmount = await renderOpenAccountMenu({
      managed: false,
      analytics: false,
      documentationUrl: null,
    });
    try {
      expect(await openSubmenu("Appearance")).toEqual(["Light", "Dark", "System"]);
    } finally {
      await unmount();
    }
  });

  test("Help & feedback lists Get started, Documentation and Send feedback when they apply", async () => {
    const unmount = await renderOpenAccountMenu({
      managed: false,
      analytics: false,
      documentationUrl: docs,
      canSendFeedback: true,
    });
    try {
      const rows = await openSubmenu("Help & feedback");
      expect(rows).toHaveLength(3);
      expect(rows[0]).toBe("Get started");
      expect(rows[1]).toContain("Documentation");
      expect(rows[2]).toBe("Send feedback");
      const link = document.body.querySelector<HTMLAnchorElement>(`a[href="${docs}"]`);
      expect(link?.target).toBe("_blank");
      expect(link?.rel).toBe("noopener noreferrer");
    } finally {
      await unmount();
    }
  });

  test("Help & feedback offers Contact support as an email link when configured", async () => {
    const unmount = await renderOpenAccountMenu({
      managed: true,
      analytics: false,
      documentationUrl: docs,
      supportEmail: "support@example.test",
      canSendFeedback: true,
    });
    try {
      const rows = await openSubmenu("Help & feedback");
      expect(rows).toHaveLength(4);
      expect(rows[0]).toBe("Get started");
      expect(rows[1]).toContain("Documentation");
      expect(rows[2]).toBe("Contact support");
      expect(rows[3]).toBe("Send feedback");
      const link = document.body.querySelector<HTMLAnchorElement>(
        'a[href="mailto:support@example.test"]',
      );
      expect(link?.textContent).toBe("Contact support");
      expect(link?.target).toBe("");
    } finally {
      await unmount();
    }
    document.body.replaceChildren();
    const supportOnly = await renderOpenAccountMenu({
      managed: false,
      analytics: false,
      documentationUrl: null,
      supportEmail: "support@example.test",
    });
    try {
      expect(await openSubmenu("Help & feedback")).toEqual(["Get started", "Contact support"]);
    } finally {
      await supportOnly();
    }
  });

  test("Help & feedback drops the rows that don't apply; Get started stays in a workspace", async () => {
    const docsOnly = await renderOpenAccountMenu({
      managed: false,
      analytics: false,
      documentationUrl: docs,
    });
    try {
      const rows = await openSubmenu("Help & feedback");
      expect(rows).toEqual(["Get started", expect.stringContaining("Documentation")]);
    } finally {
      await docsOnly();
    }
    document.body.replaceChildren();
    const nothing = await renderOpenAccountMenu({
      managed: false,
      analytics: false,
      documentationUrl: null,
    });
    try {
      const sequence = menuSequence();
      expectNoAdjacentSeparators(sequence);
      expect(await openSubmenu("Help & feedback")).toEqual(["Get started"]);
    } finally {
      await nothing();
    }
  });
});
