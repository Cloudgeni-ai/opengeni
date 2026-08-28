import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { WorkDiscoveryProjection } from "@opengeni/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { RelatedWorkAdvisory, relatedWorkMatchLabel } from "./related-work-advisory";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => GlobalRegistrator.unregister());

const projection: WorkDiscoveryProjection = {
  claims: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      sessionId: "00000000-0000-4000-8000-000000000002",
      subject: {
        namespace: "github",
        type: "pull_request",
        canonicalKey: "Cloudgeni-ai/opengeni#384",
        displayLabel: "Discovery coordination",
      },
      role: "reviewing",
      state: "active",
      revision: 3,
      provenance: "explicit_agent",
      version: { kind: "pull_request_head", value: "abc123" },
      observedAt: "2026-08-27T10:00:00.000Z",
      updatedAt: "2026-08-27T10:00:00.000Z",
      settledAt: null,
    },
  ],
  claimsTruncated: false,
  match: {
    class: "exact_subject",
    field: "subject",
    scoreBand: "exact",
    claimId: "00000000-0000-4000-8000-000000000001",
  },
  possibleOverlap: true,
  advisoryOnly: true,
  noAdditionalAccess: true,
};

describe("RelatedWorkAdvisory", () => {
  test("renders match, role, version, freshness, and explicit non-authority copy", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<RelatedWorkAdvisory projection={projection} />));
      const text = container.textContent ?? "";
      expect(text).toContain("Possible related work");
      expect(text).toContain("Exact typed subject match · exact");
      expect(text).toContain("Discovery coordination");
      expect(text).toContain("Reviewing");
      expect(text).toContain("PR head abc123");
      expect(text).toContain("Advisory only · no added access");
      expect(text).toContain("does not reserve work, transfer ownership, or authorize");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("stays absent when there is neither a match nor claim evidence", async () => {
    const empty = { ...projection, claims: [], match: null, possibleOverlap: false };
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<RelatedWorkAdvisory projection={empty} />));
      expect(container.querySelector("[data-related-work-advisory]")).toBeNull();
      expect(relatedWorkMatchLabel(empty)).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });
});
