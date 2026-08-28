import { describe, expect, test } from "bun:test";
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

  test("keeps the generic fallback for sensitive prompt prefixes and honors a user-set fallback", () => {
    for (const initialMessage of [
      "SECRET_TOKEN=hunter2 investigate the failed deployment",
      "Open https://example.com/private?token=hunter2 and inspect the failure",
      "Bearer abcdefghijklmnop investigate the failed deployment",
      "Inspect abcdefghijklmnopqrstuvwxyz1234567890",
    ]) {
      expect(
        deriveSessionDisplayTitle({
          title: AUTOMATIC_SESSION_TITLE_FALLBACK,
          titleSource: "agent",
          initialMessage,
        }),
      ).toBe(AUTOMATIC_SESSION_TITLE_FALLBACK);
    }

    expect(
      deriveSessionDisplayTitle({
        title: AUTOMATIC_SESSION_TITLE_FALLBACK,
        titleSource: "user",
        initialMessage: "Inspect the workspace",
      }),
    ).toBe(AUTOMATIC_SESSION_TITLE_FALLBACK);
  });
});
