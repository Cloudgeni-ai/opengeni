import { describe, expect, test } from "bun:test";
import type { RecordingTranscriptionModel } from "@opengeni/contracts";
import type { ClientModel, WorkspaceModelCatalogModel } from "@opengeni/sdk";

import {
  capabilityAvailability,
  UNAVAILABLE_CAPABILITY_REASON,
} from "../src/app/lib/agent-capabilities";
import {
  inferenceFeatureRestriction,
  isRegionRestricted,
  REGION_RESTRICTED,
  regionRestrictedText,
} from "../src/inference-region";
import { transcriptionModelUnavailableReason } from "../src/meetings/meeting-settings";
import { createOpenGeniText } from "../src/messages/runtime";
import {
  availabilityReasonLabel,
  projectClientModelRows,
  projectPickerRows,
} from "../src/model-policy";
import { transcriptErrorText } from "../src/recordings-model";

const t = createOpenGeniText();
const NOT_SUPPORTED = "Not supported in EU";

describe("the region-restricted reason", () => {
  test("is recognised as the code or the text the server writes, nothing else", () => {
    expect(isRegionRestricted(REGION_RESTRICTED)).toBe(true);
    expect(isRegionRestricted(NOT_SUPPORTED)).toBe(true);
    expect(isRegionRestricted("not_enabled")).toBe(false);
    expect(isRegionRestricted(null)).toBe(false);
    expect(isRegionRestricted(undefined)).toBe(false);
    expect(regionRestrictedText(t, REGION_RESTRICTED)).toBe(NOT_SUPPORTED);
    expect(regionRestrictedText(t, "credits_disabled")).toBeNull();
  });

  test("switches off any feature the server reports restricted, through one lookup", () => {
    const config = {
      inferenceFeatures: [
        { id: "web_search", available: false, unavailableReason: REGION_RESTRICTED },
        { id: "image_generation", available: true, unavailableReason: null },
        { id: "voice_input", available: false, unavailableReason: "not_configured" },
      ],
    } as never;
    expect(inferenceFeatureRestriction(t, config, "web_search")).toBe(NOT_SUPPORTED);
    expect(inferenceFeatureRestriction(t, config, "image_generation")).toBeNull();
    // Unavailable for another reason: not this mechanism's to explain.
    expect(inferenceFeatureRestriction(t, config, "voice_input")).toBeNull();
    // Older servers don't report features.
    expect(inferenceFeatureRestriction(t, {}, "video_generation")).toBeNull();
    expect(inferenceFeatureRestriction(t, null, "video_generation")).toBeNull();
  });
});

describe("models in an EU-only workspace", () => {
  const restricted = {
    status: "unavailable",
    selectable: false,
    reason: REGION_RESTRICTED,
    checkedAt: null,
  } as const;

  test("the workspace catalog shows the verdict, not the name", () => {
    const rows = projectPickerRows(t, [
      catalogModel({ id: "us/model", label: "Claude Opus 5.5 (EU)", availability: restricted }),
      catalogModel({ id: "eu/model", label: "Some US Model" }),
    ]);
    expect(rows.map((row) => [row.id, row.selectable, row.unavailableReason])).toEqual([
      ["us/model", false, NOT_SUPPORTED],
      ["eu/model", true, null],
    ]);
    expect(availabilityReasonLabel(t, REGION_RESTRICTED)).toBe(NOT_SUPPORTED);
  });

  test("the client-config list makes restricted models unselectable", () => {
    const rows = projectClientModelRows(t, [
      clientModel("us/model", { availability: restricted }),
      clientModel("eu/model"),
      clientModel("hinted/model", {
        availability: { ...restricted, reason: "missing_credential" },
      }),
    ]);
    expect(rows.map((row) => [row.id, row.selectable, row.unavailableReason])).toEqual([
      ["us/model", false, NOT_SUPPORTED],
      ["eu/model", true, null],
      // Other reasons stay hints this list never enforced.
      ["hinted/model", true, null],
    ]);
  });
});

describe("features in an EU-only workspace", () => {
  test("agent capabilities say why they're off", () => {
    const availability = capabilityAvailability({
      capabilities: [
        { id: "webSearch", available: false, reason: NOT_SUPPORTED },
        { id: "media", available: false, reason: "Missing provider" },
        { id: "knowledge", available: true },
      ],
    } as never);
    expect(availability.isAvailable("webSearch")).toBe(false);
    expect(availability.unavailableReason("webSearch")).toBe(NOT_SUPPORTED);
    expect(availability.unavailableReason("media")).toBe(UNAVAILABLE_CAPABILITY_REASON);
    expect(availability.isAvailable("knowledge")).toBe(true);
  });

  test("transcription models and errors say Not supported in EU", () => {
    const model = {
      providerId: "deepgram",
      providerName: "Deepgram",
      model: "nova-3",
      name: "Nova 3",
      available: false,
      unavailableReason: REGION_RESTRICTED,
      funding: "deployment",
    } as RecordingTranscriptionModel;
    expect(transcriptionModelUnavailableReason(model)).toBe(NOT_SUPPORTED);
    expect(transcriptErrorText(REGION_RESTRICTED)).toBe(NOT_SUPPORTED);
  });
});

function catalogModel(
  overrides: Partial<WorkspaceModelCatalogModel> & Pick<WorkspaceModelCatalogModel, "id" | "label">,
): WorkspaceModelCatalogModel {
  return {
    provider: "openai",
    providerLabel: "OpenAI",
    api: "responses",
    credentialReadiness: { status: "ready", reason: null, basis: "configuration", checkedAt: null },
    policyAllowed: true,
    availability: { status: "available", selectable: true, reason: null, checkedAt: null },
    ...overrides,
  };
}

function clientModel(id: string, overrides: Partial<ClientModel> = {}): ClientModel {
  return {
    id,
    label: id,
    provider: "openai",
    providerLabel: "OpenAI",
    api: "responses",
    ...overrides,
  } as ClientModel;
}
