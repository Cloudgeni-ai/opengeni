import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { brandedManifest, brandedPopup, brandHeading, readBrand } from "../scripts/brand";
import { BRAND, DEFAULT_BRAND } from "../src/brand";

const root = resolve(import.meta.dir, "..");

describe("branded builds", () => {
  test("unbuilt sources use Opengeni's own names", () => {
    expect(BRAND).toEqual(DEFAULT_BRAND);
  });

  test("the popup heading splits the product from the rest of the name", () => {
    expect(brandHeading({ name: "Acme Browser", product: "Acme" })).toBe(
      '<span class="wordmark">Acme</span><span class="product">Browser</span>',
    );
    expect(brandHeading({ name: "Acme", product: "Acme" })).toBe(
      '<span class="wordmark">Acme</span>',
    );
    expect(brandHeading({ name: "Tabs <for> Acme", product: "Acme" })).toBe(
      '<span class="wordmark">Tabs &#60;for&#62; Acme</span>',
    );
  });

  test("fills every popup placeholder", async () => {
    const html = brandedPopup(await readFile(join(root, "popup.html"), "utf8"), {
      name: "Acme Browser",
      product: "Acme",
    });
    expect(html).toContain("<title>Acme Browser</title>");
    expect(html).toContain("recognize this profile in Acme.");
    expect(html).not.toContain("{{");
    expect(html).not.toContain("Opengeni");
    expect(() => brandedPopup("{{unknown}}", DEFAULT_BRAND)).toThrow(/unknown placeholder/);
  });

  test("reads a brand file and brands the manifest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "brand-"));
    const file = join(dir, "brand.json");
    await writeFile(
      file,
      JSON.stringify({
        name: "Acme Browser",
        product: "Acme",
        shortName: "Acme",
        description: "Let Acme's agents work in your Chrome tabs.",
        homepageUrl: "https://acme.example",
        iconsDir: "icons",
        packageName: "acme-browser-extension",
      }),
    );
    const brand = await readBrand(file);
    expect(brand.iconsDir).toBe(join(dir, "icons"));
    const source = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    const manifest = brandedManifest(source, brand);
    expect(manifest).toMatchObject({
      name: "Acme Browser",
      short_name: "Acme",
      homepage_url: "https://acme.example",
      action: { default_title: "Acme Browser", default_popup: "popup.html" },
      permissions: source.permissions,
    });
    // Without its own key, a branded build never borrows Opengeni's extension ID.
    expect(manifest.key).toBeUndefined();
    expect(Object.keys(manifest)).toEqual(Object.keys(source).filter((key) => key !== "key"));
    const keyed = brandedManifest(source, { ...brand, key: "QUJD" });
    expect(keyed.key).toBe("QUJD");

    await writeFile(
      file,
      JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), packageName: "Bad Name" }),
    );
    await expect(readBrand(file)).rejects.toThrow(/packageName/);
  });
});
