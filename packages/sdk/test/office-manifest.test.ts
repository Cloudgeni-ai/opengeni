import { describe, expect, test } from "bun:test";

import { officeAddinId, officeAddinManifest, websocketUrl } from "../src/office";

const base = {
  id: "11111111-2222-5333-8444-555555555555",
  name: "Acme",
  description: "Chat with Acme <agents> & more",
  origin: "https://app.acme.example/",
};

describe("officeAddinId", () => {
  test("is a stable GUID per seed", async () => {
    const id = await officeAddinId("https://app.acme.example");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(await officeAddinId("https://app.acme.example")).toBe(id);
    expect(await officeAddinId("https://other.example")).not.toBe(id);
  });
});

describe("officeAddinManifest", () => {
  test("points every URL at the serving origin and asks for workbook access", () => {
    const xml = officeAddinManifest(base);
    expect(xml).toContain(`<Id>${base.id}</Id>`);
    expect(xml).toContain('<SourceLocation DefaultValue="https://app.acme.example/office/" />');
    expect(xml).toContain("<AppDomain>https://app.acme.example</AppDomain>");
    expect(xml).toContain("<Permissions>ReadWriteDocument</Permissions>");
    expect(xml).toContain('<Set Name="ExcelApi" MinVersion="1.7" />');
    const urls = [...xml.matchAll(/https?:\/\/[^"<\s]+/gu)]
      .map((match) => match[0])
      .filter((url) => !/^http:\/\/(schemas\.microsoft\.com|www\.w3\.org)\//u.test(url));
    expect(urls.length).toBeGreaterThan(5);
    for (const url of urls) expect(url.startsWith("https://app.acme.example")).toBe(true);
  });

  test("uses the product's name, escaped, and its own paths and domains", () => {
    const xml = officeAddinManifest({
      ...base,
      tooltip: "Open Acme",
      providerName: "Acme Inc",
      version: "1.2.0.0",
      taskpanePath: "/excel/pane",
      commandsPath: "/excel/commands.html",
      icons: { 32: "/brand/32.png" },
      appDomains: ["https://login.acme.example"],
    });
    expect(xml).toContain('<DisplayName DefaultValue="Acme" />');
    expect(xml).toContain("Chat with Acme &lt;agents&gt; &amp; more");
    expect(xml).toContain("<ProviderName>Acme Inc</ProviderName>");
    expect(xml).toContain("<Version>1.2.0.0</Version>");
    expect(xml).toContain('DefaultValue="https://app.acme.example/excel/pane"');
    expect(xml).toContain('DefaultValue="https://app.acme.example/excel/commands.html"');
    expect(xml).toContain('<IconUrl DefaultValue="https://app.acme.example/brand/32.png" />');
    expect(xml).toContain('DefaultValue="https://app.acme.example/office/icon-16.png"');
    expect(xml).toContain("<AppDomain>https://login.acme.example</AppDomain>");
    expect(xml).toContain('<bt:String id="Button.Tooltip" DefaultValue="Open Acme" />');
  });
});

describe("websocketUrl", () => {
  test("joins the socket path onto an absolute API base", () => {
    expect(websocketUrl("https://api.example.com/", "/v1/office/workbooks/live")).toBe(
      "wss://api.example.com/v1/office/workbooks/live",
    );
    expect(websocketUrl("http://localhost:3001", "/v1/office/workbooks/live")).toBe(
      "ws://localhost:3001/v1/office/workbooks/live",
    );
  });

  test("resolves a same-origin passthrough base against the page", () => {
    expect(
      websocketUrl("/api/opengeni", "/v1/office/workbooks/live", "https://app.acme.example/excel/"),
    ).toBe("wss://app.acme.example/api/opengeni/v1/office/workbooks/live");
  });
});
