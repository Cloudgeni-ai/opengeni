import { describe, expect, test } from "bun:test";
import type { AccessGrant } from "@opengeni/contracts";

import { rigActorForGrant } from "../src/rigs";

const grant = (subjectId: string): AccessGrant => ({
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  subjectId,
  permissions: ["rigs:manage"],
});

describe("rig version attribution", () => {
  test("records the person's subject once, not prefixed again", () => {
    expect(rigActorForGrant(grant("user:4f0c2a9e-7b1d-4c3a-9e5f-2a6b8c1d0e3f"))).toBe(
      "user:4f0c2a9e-7b1d-4c3a-9e5f-2a6b8c1d0e3f",
    );
  });
});
