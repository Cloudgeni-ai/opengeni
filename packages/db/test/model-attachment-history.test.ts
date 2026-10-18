import { describe, expect, test } from "bun:test";
import {
  MODEL_ATTACHMENT_IMAGE_MAX_DIMENSION_FIELD,
  MODEL_ATTACHMENT_REFS_FIELD,
  type ResourceRef,
} from "@opengeni/contracts";
import { durableUserHistoryItem } from "../src/index";

describe("durable user attachment history", () => {
  test("stores file refs beside the message without inline bytes or repository resources", () => {
    const resources: ResourceRef[] = [
      {
        kind: "file",
        fileId: "00000000-0000-4000-8000-000000000071",
        mountPath: "references",
      },
      {
        kind: "repository",
        uri: "https://github.com/cloudgeni-ai/opengeni.git",
        ref: "main",
        provider: "github",
      },
    ];

    const item = durableUserHistoryItem("inspect", resources);

    expect(item).toEqual({
      type: "message",
      role: "user",
      content: "inspect",
      [MODEL_ATTACHMENT_REFS_FIELD]: [resources[0]],
      // Stamped at acceptance, so later bound changes never re-render it.
      [MODEL_ATTACHMENT_IMAGE_MAX_DIMENSION_FIELD]: 2000,
    });
    expect(JSON.stringify(item)).not.toContain("base64");
  });

  test("a message without files carries no image bound", () => {
    const item = durableUserHistoryItem("hello", []);
    expect(item).toEqual({ type: "message", role: "user", content: "hello" });
  });
});
