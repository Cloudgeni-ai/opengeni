import { describe, expect, test } from "bun:test";
import { officeAddinId, officeAddinManifest } from "./office-manifest";

describe("Office add-in manifest", () => {
  test("each deployment origin gets its own stable add-in id", () => {
    const id = officeAddinId("https://app.example.com");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(officeAddinId("https://app.example.com")).toBe(id);
    expect(officeAddinId("https://other.example.com")).not.toBe(id);
  });

  test("points every URL at the serving origin and asks for workbook access", () => {
    const xml = officeAddinManifest("https://app.example.com");
    expect(xml).toContain(`<Id>${officeAddinId("https://app.example.com")}</Id>`);
    expect(xml).toContain('<SourceLocation DefaultValue="https://app.example.com/office/" />');
    expect(xml).toContain("<AppDomain>https://app.example.com</AppDomain>");
    expect(xml).toContain("<Permissions>ReadWriteDocument</Permissions>");
    expect(xml).toContain('<Set Name="ExcelApi" MinVersion="1.7" />');
    const urls = [...xml.matchAll(/https?:\/\/[^"<\s]+/gu)]
      .map((match) => match[0])
      .filter((url) => !/^http:\/\/(schemas\.microsoft\.com|www\.w3\.org)\//u.test(url));
    expect(urls.length).toBeGreaterThan(5);
    for (const url of urls) expect(url.startsWith("https://app.example.com")).toBe(true);
  });
});
