import { describe, expect, test } from "bun:test";

import { capabilitiesSectionFromSearch, readyMadeKindFromSearch } from "./capabilities-section";

describe("capabilities sections", () => {
  test("parses the three tabs and keeps older tab links working", () => {
    expect(capabilitiesSectionFromSearch("skills")).toBe("skills");
    expect(capabilitiesSectionFromSearch("ready-made")).toBe("ready-made");
    expect(capabilitiesSectionFromSearch("plugins")).toBe("ready-made");
    expect(capabilitiesSectionFromSearch("gallery")).toBe("ready-made");
    expect(capabilitiesSectionFromSearch("toString")).toBeUndefined();
    expect(capabilitiesSectionFromSearch(undefined)).toBeUndefined();
  });

  test("narrows Ready-made only to known kinds", () => {
    expect(readyMadeKindFromSearch("agent")).toBe("agent");
    expect(readyMadeKindFromSearch("plugin")).toBeUndefined();
  });
});
