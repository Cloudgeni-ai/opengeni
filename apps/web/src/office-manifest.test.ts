import { describe, expect, test } from "bun:test";
import { opengeniOfficeAddinId, opengeniOfficeManifest } from "./office-manifest";

describe("Opengeni's Excel add-in manifest", () => {
  test("keeps each deployment's add-in id", async () => {
    // The id Excel already knows for this origin; it must never change.
    expect(await opengeniOfficeAddinId("https://app.example.com")).toBe(
      "ad98027b-675e-5489-9acc-6311890e81d7",
    );
    expect(await opengeniOfficeAddinId("https://other.example.com")).not.toBe(
      await opengeniOfficeAddinId("https://app.example.com"),
    );
  });

  test("names this deployment and serves everything from its origin", async () => {
    const xml = await opengeniOfficeManifest("https://app.example.com");
    expect(xml).toContain('<DisplayName DefaultValue="Opengeni" />');
    expect(xml).toContain("(app.example.com)");
    expect(xml).toContain('<SourceLocation DefaultValue="https://app.example.com/office/" />');
  });
});
