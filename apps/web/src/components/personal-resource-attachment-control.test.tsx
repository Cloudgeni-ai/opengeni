import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { PersonalResourceAttachmentController } from "@/lib/use-personal-resource-attachment";
import { PersonalResourceAttachmentControl } from "./personal-resource-attachment-control";

function controller(
  overrides: Partial<PersonalResourceAttachmentController> = {},
): PersonalResourceAttachmentController {
  return {
    eligible: true,
    loading: false,
    refreshing: false,
    error: null,
    notice: null,
    sourceLost: false,
    truncated: false,
    catalog: null,
    selected: {
      variableSets: [],
      rigs: [],
      connectedMachines: [{ enrollmentId: "machine-1", name: "My machine" }],
      resourceCount: 1,
      personalResourceCount: 1,
      closureUnverified: false,
    },
    mode: "once",
    visibility: "workspace",
    requiresDecision: false,
    intent: undefined,
    refresh: async () => undefined,
    onAccepted: () => undefined,
    onDeliveryError: () => undefined,
    ...overrides,
  };
}

describe("PersonalResourceAttachmentControl", () => {
  test("does not add passive personal-resource copy above the composer", () => {
    expect(
      renderToStaticMarkup(<PersonalResourceAttachmentControl controller={controller()} compact />),
    ).toBe("");
  });

  test("keeps actionable recovery states visible", () => {
    const markup = renderToStaticMarkup(
      <PersonalResourceAttachmentControl
        controller={controller({ error: new Error("catalog unavailable") })}
        compact
      />,
    );

    expect(markup).toContain("The selected personal resource is unavailable");
    expect(markup).toContain("Retry");
  });
});
