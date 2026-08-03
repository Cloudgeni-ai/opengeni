import { describe, expect, test } from "bun:test";
import { MODEL_ATTACHMENT_REFS_FIELD, type ResourceRef } from "@opengeni/contracts";
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
    });
    expect(JSON.stringify(item)).not.toContain("base64");
  });
});
