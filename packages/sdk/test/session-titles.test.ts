import { describe, expect, spyOn, test } from "bun:test";
import { AUTOMATIC_SESSION_TITLE_FALLBACK as CONTRACT_TITLE_FALLBACK } from "@opengeni/contracts";
import {
  AUTOMATIC_SESSION_TITLE_FALLBACK,
  deriveSessionDisplayTitle,
  sessionTitleIsPending,
} from "../src";

describe("session display titles", () => {
  test("keeps the client pending marker aligned with the durable contract", () => {
    expect(AUTOMATIC_SESSION_TITLE_FALLBACK).toBe(CONTRACT_TITLE_FALLBACK);
  });

  test("treats only non-user fallback or missing titles as pending", () => {
    expect(sessionTitleIsPending({ title: null, titleSource: null })).toBe(true);
    expect(
      sessionTitleIsPending({
        title: AUTOMATIC_SESSION_TITLE_FALLBACK,
        titleSource: "agent",
      }),
    ).toBe(true);
    expect(sessionTitleIsPending({ title: "Session naming repair", titleSource: "agent" })).toBe(
      false,
    );
    expect(
      sessionTitleIsPending({
        title: AUTOMATIC_SESSION_TITLE_FALLBACK,
        titleSource: "user",
      }),
    ).toBe(false);
    expect(sessionTitleIsPending({ title: "   ", titleSource: "user" })).toBe(false);
  });

  test("shows a bounded opening-prompt preview until the semantic title arrives", () => {
    expect(
      deriveSessionDisplayTitle({
        title: AUTOMATIC_SESSION_TITLE_FALLBACK,
        titleSource: "agent",
        initialMessage:
          "Investigate automatic conversation title generation across retries recovery providers interfaces dashboards integrations and notifications",
      }),
    ).toBe("Investigate automatic conversation title generation across retries recovery");

    expect(
      deriveSessionDisplayTitle({
        title: "Automatic Session Naming",
        titleSource: "agent",
        initialMessage: "A later prompt preview must not replace durable metadata",
      }),
    ).toBe("Automatic Session Naming");

    expect(
      deriveSessionDisplayTitle({
        title: AUTOMATIC_SESSION_TITLE_FALLBACK,
        titleSource: "agent",
        initialMessage:
          "https://homeserver.example.test/workspaces/one/sessions/two\nFix default session naming behavior",
      }),
    ).toBe("Fix default session naming behavior");
  });

  test("preserves metadata precedence when a host requests it", () => {
    expect(
      deriveSessionDisplayTitle(
        {
          title: AUTOMATIC_SESSION_TITLE_FALLBACK,
          titleSource: "agent",
          initialMessage: "Inspect the workspace",
          metadata: { name: "Nightly drift check" },
        },
        { metadataKeys: ["title", "name"] },
      ),
    ).toBe("Nightly drift check");
  });

  test("uses a session reference for unsafe prompts and honors a user-set fallback", () => {
    for (const initialMessage of [
      "SECRET_TOKEN=hunter2 investigate the failed deployment",
      "Open https://example.com/private?token=hunter2 and inspect the failure",
      "Open example.com/account and inspect the failure",
      "Open localhost:3000/admin and inspect the failure",
      "oauth.clientSecret=swordfish investigate the failure",
      "Bearer abcdefghijklmnop investigate the failed deployment",
      "Inspect abcdefghijklmnopqrstuvwxyz1234567890",
    ]) {
      expect(
        deriveSessionDisplayTitle({
          id: "123e4567-e89b-42d3-a456-426614174000",
          title: AUTOMATIC_SESSION_TITLE_FALLBACK,
          titleSource: "agent",
          initialMessage,
        }),
      ).toBe("Conversation 123e4567-e89b");
    }

    expect(
      deriveSessionDisplayTitle({
        title: AUTOMATIC_SESSION_TITLE_FALLBACK,
        titleSource: "user",
        initialMessage: "Inspect the workspace",
      }),
    ).toBe(AUTOMATIC_SESSION_TITLE_FALLBACK);

    expect(
      deriveSessionDisplayTitle({
        id: "123e4567-e89b-42d3-a456-426614174000",
        title: "   ",
        titleSource: "user",
        initialMessage: "Inspect the workspace",
      }),
    ).toBe("Conversation 123e4567-e89b");

    expect(
      deriveSessionDisplayTitle({
        title: AUTOMATIC_SESSION_TITLE_FALLBACK,
        titleSource: "agent",
        initialMessage: "API_TOKEN=hunter2",
      }),
    ).toBe(AUTOMATIC_SESSION_TITLE_FALLBACK);
  });

  test("bounds a very large prompt before splitting it into preview lines", () => {
    const initialMessage = `Inspect the repo\n${" \n".repeat(100_000)}`;
    const splitInputLengths: number[] = [];
    const stringPrototype = String.prototype as unknown as {
      split: (separator?: string | RegExp, limit?: number) => string[];
    };
    const originalSplit = stringPrototype.split;
    const split = spyOn(stringPrototype, "split").mockImplementation(function (
      this: string,
      separator?: string | RegExp,
      limit?: number,
    ): string[] {
      splitInputLengths.push(this.length);
      return originalSplit.call(this, separator, limit);
    });
    try {
      expect(
        deriveSessionDisplayTitle({
          title: AUTOMATIC_SESSION_TITLE_FALLBACK,
          titleSource: "agent",
          initialMessage,
        }),
      ).toBe("Inspect the repo");
    } finally {
      split.mockRestore();
    }

    expect(initialMessage.length).toBeGreaterThan(100_000);
    expect(Math.max(...splitInputLengths)).toBeLessThan(10_000);
  });
});
