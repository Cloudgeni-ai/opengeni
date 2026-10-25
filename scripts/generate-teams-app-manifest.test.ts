import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
  buildTeamsAppManifest,
  teamsManifestOptionsFromEnv,
  writeTeamsAppPackage,
  type TeamsManifestOptions,
} from "./generate-teams-app-manifest";

const options: TeamsManifestOptions = {
  appId: "11111111-1111-4111-8111-111111111111",
  botId: "22222222-2222-4222-8222-222222222222",
  publicBaseUrl: "https://pilot.example.com",
  websiteUrl: "https://example.com",
  privacyUrl: "https://example.com/privacy",
  termsOfUseUrl: "https://example.com/terms",
};

describe("Teams app package", () => {
  test("separates package and bot identity and advertises only supported scopes", () => {
    const manifest = buildTeamsAppManifest(options);
    expect(manifest.id).toBe(options.appId);
    expect(manifest.bots[0]?.botId).toBe(options.botId);
    expect(manifest.bots[0]?.scopes).toEqual(["personal", "team"]);
    expect(manifest.manifestVersion).toBe("1.25");
    expect(manifest.validDomains).toEqual(["pilot.example.com"]);
    for (const key of [
      "permissions",
      "authorization",
      "webApplicationInfo",
      "supportedChannelTypes",
      "supportsChannelFeatures",
      "staticTabs",
    ]) {
      expect(manifest).not.toHaveProperty(key);
    }
  });

  test("rejects unusable identities and unsafe deployment metadata before writing", () => {
    for (const appId of ["", "placeholder", "00000000-0000-0000-0000-000000000000"]) {
      expect(() => buildTeamsAppManifest({ ...options, appId })).toThrow();
    }
    for (const publicBaseUrl of [
      "http://example.com",
      "https://user:secret@example.com",
      "https://example.com/path",
      "https://example.com?token=secret",
    ]) {
      expect(() => buildTeamsAppManifest({ ...options, publicBaseUrl })).toThrow();
    }
    expect(() => buildTeamsAppManifest({ ...options, privacyUrl: "http://example.com" })).toThrow();
    expect(() => buildTeamsAppManifest({ ...options, version: "1.0.0-preview" })).toThrow();
    expect(() => buildTeamsAppManifest({ ...options, appName: "x".repeat(31) })).toThrow();
  });

  test("requires explicit legal URLs and never serializes runtime secrets", () => {
    expect(() => teamsManifestOptionsFromEnv({})).toThrow("OPENGENI_TEAMS_APP_ID");
    const env = {
      OPENGENI_TEAMS_APP_ID: options.appId,
      OPENGENI_TEAMS_BOT_CLIENT_ID: options.botId,
      OPENGENI_PUBLIC_BASE_URL: options.publicBaseUrl,
      OPENGENI_TEAMS_WEBSITE_URL: options.websiteUrl,
      OPENGENI_TEAMS_PRIVACY_URL: options.privacyUrl,
      OPENGENI_TEAMS_TERMS_URL: options.termsOfUseUrl,
      OPENGENI_TEAMS_BOT_CLIENT_SECRET: "must-never-enter-package",
      OPENGENI_TEAMS_BOT_ALLOWED_TENANT_IDS: "private-review-tenant",
    };
    const wire = JSON.stringify(buildTeamsAppManifest(teamsManifestOptionsFromEnv(env)));
    expect(wire).not.toContain(env.OPENGENI_TEAMS_BOT_CLIENT_SECRET);
    expect(wire).not.toContain(env.OPENGENI_TEAMS_BOT_ALLOWED_TENANT_IDS);
  });

  test("builds real correctly sized brand PNGs and refuses overwriting a package", async () => {
    const parent = await mkdtemp(join(tmpdir(), "opengeni-teams-package-"));
    const output = join(parent, "package");
    try {
      await writeTeamsAppPackage(options, output);
      expect(JSON.parse(await readFile(join(output, "manifest.json"), "utf8")).id).toBe(
        options.appId,
      );
      const color = await sharp(join(output, "color.png")).metadata();
      expect([color.format, color.width, color.height]).toEqual(["png", 192, 192]);
      const outline = await sharp(join(output, "outline.png"))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect([outline.info.width, outline.info.height, outline.info.channels]).toEqual([32, 32, 4]);
      let visible = 0;
      let transparent = 0;
      for (let offset = 0; offset < outline.data.length; offset += 4) {
        const alpha = outline.data[offset + 3];
        if (alpha === 0) transparent++;
        else {
          visible++;
          expect([...outline.data.subarray(offset, offset + 3)]).toEqual([255, 255, 255]);
        }
      }
      expect(visible).toBeGreaterThan(0);
      expect(transparent).toBeGreaterThan(0);
      await expect(writeTeamsAppPackage(options, output)).rejects.toThrow();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
