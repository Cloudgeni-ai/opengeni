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
    mode: "session",
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
  test.each(["private", "workspace"] as const)(
    "adds no authorization UI for healthy %s attachments",
    (visibility) => {
      expect(
        renderToStaticMarkup(
          <PersonalResourceAttachmentControl controller={controller({ visibility })} compact />,
        ),
      ).toBe("");
    },
  );

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

test.each([
  [
    "source_changed",
    "Access to the selected personal resource changed. Choose an available resource before submitting.",
  ],
  ["reloading", "Session authority changed. Reloading personal resources before retrying."],
  ["reload_failed", "Session authority could not be refreshed. Retry before sending again."],
  ["reloaded", "Session authority changed. Personal resources were reloaded before retrying."],
] as const)("renders exact %s status text from the lazy notice projection", (notice, message) => {
  expect(
    renderToStaticMarkup(<PersonalResourceAttachmentControl controller={controller({ notice })} />),
  ).toContain(message);
});
