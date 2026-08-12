import { describe, expect, test } from "bun:test";

import type { IntegrationFacetBindingSummary, IntegrationFacetDefinitionSummary } from "@/types";

import {
  facetConfigFromForm,
  facetFields,
  facetFormState,
  unsupportedRequiredFacetFields,
} from "./integration-facets-panel";

const driveDefinition: IntegrationFacetDefinitionSummary = {
  facetKey: "drive-content",
  kind: "knowledge_source",
  configSchema: {
    type: "object",
    required: ["sourceId", "sourceKind"],
    properties: {
      sourceId: { type: "string", minLength: 1, maxLength: 512 },
      sourceKind: { type: "string", enum: ["my_drive", "shared_drive", "folder"] },
      includeDescendants: { type: "boolean" },
      lookaheadDays: { type: "integer", minimum: 1, maximum: 365 },
      ignoredObject: { type: "object" },
    },
    additionalProperties: false,
  },
  capabilities: { provider: "google-drive", connectionRequired: true },
};

describe("Integration facet schema forms", () => {
  test("turns the bounded adapter schema into human-editable primitive fields", () => {
    expect(facetFields(driveDefinition)).toEqual([
      {
        key: "sourceId",
        label: "Source Id",
        type: "string",
        required: true,
        options: [],
      },
      {
        key: "sourceKind",
        label: "Source Kind",
        type: "string",
        required: true,
        options: ["my_drive", "shared_drive", "folder"],
      },
      {
        key: "includeDescendants",
        label: "Include Descendants",
        type: "boolean",
        required: false,
        options: [],
      },
      {
        key: "lookaheadDays",
        label: "Lookahead Days",
        type: "integer",
        required: false,
        options: [],
        min: 1,
        max: 365,
      },
    ]);
  });

  test("starts required enums safely and emits typed config without empty optional strings", () => {
    const state = facetFormState(driveDefinition, null);
    expect(state).toEqual({
      sourceId: "",
      sourceKind: "my_drive",
      includeDescendants: false,
      lookaheadDays: "",
    });
    expect(
      facetConfigFromForm(driveDefinition, {
        ...state,
        sourceId: "folder:finance",
        sourceKind: "folder",
        includeDescendants: true,
        lookaheadDays: "30",
      }),
    ).toEqual({
      sourceId: "folder:finance",
      sourceKind: "folder",
      includeDescendants: true,
      lookaheadDays: 30,
    });
  });

  test("rehydrates one exact binding without exposing cursor contents", () => {
    const binding: IntegrationFacetBindingSummary = {
      id: "00000000-0000-4000-8000-000000000701",
      facetKey: "drive-content",
      kind: "knowledge_source",
      bindingKey: "finance",
      displayName: "Finance source",
      connectionId: "00000000-0000-4000-8000-000000000702",
      status: "active",
      config: {
        sourceId: "shared-drive:finance",
        sourceKind: "shared_drive",
        includeDescendants: true,
      },
      version: 4,
      hasCursor: true,
      lastSuccessAt: "2026-08-11T00:00:00.000Z",
      lastErrorCode: null,
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z",
    };
    expect(facetFormState(driveDefinition, binding)).toEqual({
      sourceId: "shared-drive:finance",
      sourceKind: "shared_drive",
      includeDescendants: true,
      lookaheadDays: "",
    });
    expect(JSON.stringify(binding)).not.toContain("page_token");
  });

  test("refuses required nested configuration that the generic editor cannot represent", () => {
    const richDriveDefinition: IntegrationFacetDefinitionSummary = {
      facetKey: "drive-content",
      kind: "knowledge_source",
      configSchema: {
        type: "object",
        required: ["sources", "destination", "syncCadence", "readPolicy"],
        properties: {
          sources: { type: "array", items: { type: "object" } },
          destination: { type: "object" },
          syncCadence: { type: "string", enum: ["manual", "hourly", "daily"] },
          readPolicy: { type: "string", enum: ["allow", "ask", "block"] },
        },
      },
      capabilities: { provider: "microsoft-onedrive", connectionRequired: true },
    };

    expect(unsupportedRequiredFacetFields(richDriveDefinition)).toEqual(["sources", "destination"]);
  });
});
