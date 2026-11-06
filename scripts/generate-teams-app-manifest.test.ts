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
    expect(manifest.bots[0]?.scopes).toEqual(["personal"]);
    expect(buildTeamsAppManifest({ ...options, groupChats: true }).bots[0]?.scopes).toEqual([
      "personal",
      "groupChat",
    ]);
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

  test("names the publisher, configurable, with Opengeni's partner ID by default", () => {
    const manifest = buildTeamsAppManifest(options);
    expect(manifest.developer).toMatchObject({ name: "Opengeni", mpnId: "7181379" });
    const custom = buildTeamsAppManifest({ ...options, developerName: "Example AS", mpnId: "42" });
    expect(custom.developer).toMatchObject({ name: "Example AS", mpnId: "42" });
    expect(
      buildTeamsAppManifest({ ...options, developerName: " Example AS " }).developer.name,
    ).toBe("Example AS");
    expect(buildTeamsAppManifest({ ...options, mpnId: null }).developer).not.toHaveProperty(
      "mpnId",
    );
    for (const developerName of ["", "  ", "x".repeat(33)])
      expect(() => buildTeamsAppManifest({ ...options, developerName })).toThrow("developerName");
    for (const mpnId of ["", "MPN-1", "12345678901"])
      expect(() => buildTeamsAppManifest({ ...options, mpnId })).toThrow("mpnId");

    const env = {
      OPENGENI_TEAMS_APP_ID: options.appId,
      OPENGENI_TEAMS_BOT_CLIENT_ID: options.botId,
      OPENGENI_PUBLIC_BASE_URL: options.publicBaseUrl,
      OPENGENI_TEAMS_WEBSITE_URL: options.websiteUrl,
      OPENGENI_TEAMS_PRIVACY_URL: options.privacyUrl,
      OPENGENI_TEAMS_TERMS_URL: options.termsOfUseUrl,
    };
    expect(teamsManifestOptionsFromEnv(env)).toMatchObject({
      developerName: undefined,
      mpnId: undefined,
    });
    expect(
      teamsManifestOptionsFromEnv({
        ...env,
        OPENGENI_TEAMS_DEVELOPER_NAME: " Example AS ",
        OPENGENI_TEAMS_MPN_ID: "42",
      }),
    ).toMatchObject({ developerName: "Example AS", mpnId: "42" });
    expect(teamsManifestOptionsFromEnv({ ...env, OPENGENI_TEAMS_MPN_ID: "none" }).mpnId).toBeNull();
    expect(
      teamsManifestOptionsFromEnv({ ...env, OPENGENI_TEAMS_MPN_ID: "" }).mpnId,
    ).toBeUndefined();
  });

  test("describes the app, its AI, its requirements and its limits within Store limits", () => {
    for (const variant of [options, { ...options, groupChats: true }]) {
      const { short, full } = buildTeamsAppManifest(variant).description;
      expect(short.length).toBeLessThanOrEqual(80);
      expect(full.length).toBeLessThanOrEqual(4000);
      expect(short).toContain("Microsoft Teams");
      expect(short).not.toContain("Opengeni");
      expect(short).not.toMatch(/\bapp\b/i);
      expect(full).not.toContain(short);
      // The first mention of Teams is "Microsoft Teams".
      expect(full.indexOf("Teams")).toBe(full.indexOf("Microsoft Teams") + "Microsoft ".length);
      expect(full).toContain("AI");
      expect(full).toContain("Opengeni account");
      expect(full).toContain("Limitations:");
      expect(full).toContain('"help"');
      // A way to sign up, and the one-time admin setup, are in the description.
      expect(full).toContain(`Visit ${options.websiteUrl} to sign up`);
      expect(full).toContain("an administrator must first connect");
      expect(full).toContain("account with access to that workspace");
      expect(full).toContain("thumbs down");
    }
    expect(buildTeamsAppManifest({ ...options, groupChats: true }).description.full).toContain(
      "every participant must have linked an Opengeni account with access to that workspace",
    );
    expect(buildTeamsAppManifest(options).description.full).not.toContain("group chat");
  });

  test("lists help, account commands and prompt starters for personal chats", () => {
    const personal = buildTeamsAppManifest(options).bots[0]!.commandLists;
    expect(personal).toHaveLength(1);
    expect(personal[0]!.scopes).toEqual(["personal"]);
    expect(personal[0]!.commands.map((command) => command.title)).toEqual([
      "help",
      "link",
      "unlink",
      "Research a topic",
      "Draft a message",
      "Plan a project",
    ]);
    const shared = buildTeamsAppManifest({ ...options, groupChats: true }).bots[0]!.commandLists;
    expect(shared[1]).toEqual({
      scopes: ["groupChat"],
      commands: [{ title: "help", description: "See what Opengeni can do in this conversation" }],
    });
    // The v1.25 schema accepts only these scope spellings (not "groupchat").
    const bot = buildTeamsAppManifest({ ...options, groupChats: true }).bots[0]!;
    for (const scope of [...bot.scopes, ...bot.commandLists.flatMap((list) => list.scopes)])
      expect(["team", "personal", "groupChat", "copilot"]).toContain(scope);
    // Kept within Teams' documented display limits (stricter than the 1.25
    // schema): 10 commands per list, titles of 32 characters, descriptions of 128.
    for (const list of shared) {
      expect(list.commands.length).toBeLessThanOrEqual(10);
      for (const command of list.commands) {
        expect(command.title.length).toBeLessThanOrEqual(32);
        expect(command.description.length).toBeLessThanOrEqual(128);
      }
    }
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
