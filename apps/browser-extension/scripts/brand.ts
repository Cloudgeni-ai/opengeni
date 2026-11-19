// A product's branded build of the extension: its names, summary, icons and,
// optionally, the manifest key that fixes its unpacked extension ID. Read
// from the JSON file passed to `scripts/build.ts --brand <file>`; paths in it
// are relative to that file.

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ExtensionBrand } from "../src/brand";

export type BuildBrand = ExtensionBrand & {
  /** Chrome's short name, at most 12 characters. */
  shortName: string;
  /** The store and extensions-page summary, at most 132 characters. */
  description: string;
  homepageUrl: string;
  /** A folder with brand-mark.svg and icon-16/32/48/128.png. */
  iconsDir: string;
  /**
   * The manifest `key` (a base64 public key) for unpacked builds, so their ID
   * stays fixed. Store builds never carry it; the store assigns the ID.
   */
  key: string | null;
  /** File and folder names for the built archives, e.g. "opengeni-browser-extension". */
  packageName: string;
};

export const ICON_FILES = [
  "brand-mark.svg",
  "icon-16.png",
  "icon-32.png",
  "icon-48.png",
  "icon-128.png",
] as const;

const text = (value: unknown, field: string, max: number): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`Brand ${field} must be a non-empty string of at most ${max} characters`);
  }
  return value.trim();
};

/** The heading's markup: the product name large, the rest of the name beside it. */
export function brandHeading(brand: ExtensionBrand): string {
  const escape = (value: string) =>
    value.replace(/[&<>"']/gu, (char) => `&#${char.charCodeAt(0)};`);
  const rest = brand.name.startsWith(brand.product)
    ? brand.name.slice(brand.product.length).trim()
    : "";
  if (!brand.name.startsWith(brand.product)) {
    return `<span class="wordmark">${escape(brand.name)}</span>`;
  }
  return `<span class="wordmark">${escape(brand.product)}</span>${rest ? `<span class="product">${escape(rest)}</span>` : ""}`;
}

/** Fill the popup's `{{…}}` placeholders. */
export function brandedPopup(html: string, brand: ExtensionBrand): string {
  const escape = (value: string) =>
    value.replace(/[&<>"']/gu, (char) => `&#${char.charCodeAt(0)};`);
  const filled = html
    .replaceAll("{{name}}", escape(brand.name))
    .replaceAll("{{product}}", escape(brand.product))
    .replaceAll("{{heading}}", brandHeading(brand));
  if (/\{\{\w+\}\}/u.test(filled)) throw new Error("popup.html has an unknown placeholder");
  return filled;
}

/** Opengeni's own build, from the checked-in manifest and icons. */
export function defaultBrand(manifest: Record<string, unknown>, root: string): BuildBrand {
  return {
    name: text(manifest.name, "name", 75),
    product: "Opengeni",
    shortName: text(manifest.short_name, "shortName", 12),
    description: text(manifest.description, "description", 132),
    homepageUrl: text(manifest.homepage_url, "homepageUrl", 2048),
    iconsDir: resolve(root, "icons"),
    key: typeof manifest.key === "string" ? manifest.key : null,
    packageName: "opengeni-browser-extension",
  };
}

export async function readBrand(file: string): Promise<BuildBrand> {
  const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  const homepageUrl = text(raw.homepageUrl, "homepageUrl", 2048);
  if (!/^https:\/\//u.test(homepageUrl)) throw new Error("Brand homepageUrl must be https");
  const packageName = text(raw.packageName, "packageName", 64);
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(packageName)) {
    throw new Error("Brand packageName must be lowercase letters, digits and dashes");
  }
  if (
    raw.key !== undefined &&
    (typeof raw.key !== "string" || !/^[A-Za-z0-9+/=]+$/u.test(raw.key))
  ) {
    throw new Error("Brand key must be a base64 public key");
  }
  return {
    name: text(raw.name, "name", 75),
    product: text(raw.product, "product", 40),
    shortName: text(raw.shortName, "shortName", 12),
    description: text(raw.description, "description", 132),
    homepageUrl,
    iconsDir: resolve(dirname(file), text(raw.iconsDir, "iconsDir", 1024)),
    key: typeof raw.key === "string" ? raw.key : null,
    packageName,
  };
}

/** The manifest with the brand's names, summary, homepage and key. */
export function brandedManifest(
  source: Record<string, unknown>,
  brand: BuildBrand,
): Record<string, unknown> {
  const action = (source.action ?? {}) as Record<string, unknown>;
  // Overwriting the source's own fields keeps its field order.
  const manifest: Record<string, unknown> = {
    ...source,
    name: brand.name,
    short_name: brand.shortName,
    description: brand.description,
    homepage_url: brand.homepageUrl,
    key: brand.key,
    action: { ...action, default_title: brand.name },
  };
  if (!brand.key) delete manifest.key;
  return manifest;
}
