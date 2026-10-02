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

  test("Help & feedback lists Documentation and Send feedback when both apply", async () => {
    const unmount = await renderOpenAccountMenu({
      managed: false,
      analytics: false,
      documentationUrl: docs,
      canSendFeedback: true,
    });
    try {
      const rows = await openSubmenu("Help & feedback");
      expect(rows).toHaveLength(2);
      expect(rows[0]).toContain("Documentation");
      expect(rows[1]).toBe("Send feedback");
      const link = document.body.querySelector<HTMLAnchorElement>(`a[href="${docs}"]`);
      expect(link?.target).toBe("_blank");
      expect(link?.rel).toBe("noopener noreferrer");
    } finally {
      await unmount();
    }
  });

  test("Help & feedback drops the rows that don't apply, and itself when none do", async () => {
    const docsOnly = await renderOpenAccountMenu({
      managed: false,
      analytics: false,
      documentationUrl: docs,
    });
    try {
      const rows = await openSubmenu("Help & feedback");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toContain("Documentation");
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
      expect(sequence.join("|")).not.toContain("Help");
    } finally {
      await nothing();
    }
  });
});
