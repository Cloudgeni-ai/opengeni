import { describe, expect, test } from "bun:test";
import {
  officeManifestPublisherFromEnvironment,
  opengeniOfficeAddinId,
  opengeniOfficeManifest,
} from "./office-manifest";

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
    expect(xml).toContain("<ProviderName>Opengeni</ProviderName>");
    expect(xml).toContain('<SupportUrl DefaultValue="https://app.example.com/excel" />');
  });

  test("uses the store publisher's name and support page when set", async () => {
    const publisher = officeManifestPublisherFromEnvironment({
      OPENGENI_OFFICE_ADDIN_PROVIDER_NAME: " Example AS ",
      OPENGENI_OFFICE_ADDIN_SUPPORT_URL: "https://docs.example.com/excel-add-in",
      OPENGENI_OFFICE_ADDIN_NAME: "",
    });
    expect(publisher).toEqual({
      providerName: "Example AS",
      supportUrl: "https://docs.example.com/excel-add-in",
    });
    const xml = await opengeniOfficeManifest("https://app.example.com", publisher);
    expect(xml).toContain("<ProviderName>Example AS</ProviderName>");
    expect(xml).toContain('<SupportUrl DefaultValue="https://docs.example.com/excel-add-in" />');
    expect(officeManifestPublisherFromEnvironment({})).toEqual({
      providerName: undefined,
      supportUrl: undefined,
    });
  });
});
