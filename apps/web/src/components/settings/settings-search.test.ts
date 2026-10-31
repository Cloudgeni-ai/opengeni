import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import {
  BotIcon,
  KeyRoundIcon,
  MonitorIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
} from "lucide-react";

import { searchSettings, settingsSearchEntries } from "./settings-search";
import type { SettingsRailSection } from "./settings-sidebar";

const link = (search: Record<string, string>) => createElement("a", { search });

const SECTIONS: SettingsRailSection[] = [
  {
    id: "workspace",
    label: "Workspace",
    groups: [
      {
        items: [
          {
            id: "workspace:general",
            label: "General",
            icon: SlidersHorizontalIcon,
            link: link({ section: "general" }),
          },
          {
            id: "workspace:api-keys",
            label: "API keys",
            icon: KeyRoundIcon,
            link: link({ section: "api-keys" }),
          },
        ],
      },
    ],
  },
  {
    id: "organization",
    label: "Organization",
    groups: [
      {
        items: [
          {
            id: "organization:models",
            label: "Models",
            icon: SparklesIcon,
            link: link({ section: "models" }),
          },
          {
            id: "organization:agents",
            label: "Connected agents",
            icon: BotIcon,
            link: link({ section: "agents" }),
          },
        ],
      },
    ],
  },
  {
    id: "account",
    label: "Your account",
    groups: [
      {
        items: [
          {
            id: "account:security",
            label: "Security",
            icon: ShieldCheckIcon,
            link: link({}),
          },
        ],
      },
    ],
  },
];

const entries = settingsSearchEntries(SECTIONS);
const labels = (query: string) => searchSettings(entries, query).map((entry) => entry.label);

describe("settings search", () => {
  test("indexes every rail page and the settings inside it, in rail order", () => {
    const general = entries.findIndex((entry) => entry.id === "workspace:general");
    const voice = entries.findIndex((entry) => entry.label === "Voice input");
    const apiKeys = entries.findIndex((entry) => entry.id === "workspace:api-keys");
    expect(general).toBe(0);
    expect(voice).toBeGreaterThan(general);
    expect(apiKeys).toBeGreaterThan(voice);
    expect(entries[voice]!.location).toBe("Workspace · General");
    expect(entries[general]!.location).toBe("Workspace");
  });

  test("settings of pages the person can't use are never offered", () => {
    // No Developer page in this rail: none of its settings either.
    expect(labels("webhook")).toEqual([]);
    expect(labels("service accounts")).toEqual([]);
  });

  test("a setting with its own sub-page links straight to it", () => {
    const create = entries.find((entry) => entry.label === "Create API key")!;
    expect((create.link.props as { search: unknown }).search).toEqual({
      section: "api-keys",
      key: "new",
    });
    // A setting without one opens its page.
    const voice = entries.find((entry) => entry.label === "Voice input")!;
    expect((voice.link.props as { search: unknown }).search).toEqual({ section: "general" });
  });

  test("finds the MCP setup by the words people use for it", () => {
    for (const query of ["mcp", "claude code", "Cursor", "coding agent", "install"]) {
      expect(labels(query)).toContain("Connected agents");
    }
    // The setup by its own name first, then its page.
    expect(labels("mcp").slice(0, 2)).toEqual(["Opengeni MCP server", "Connected agents"]);
    expect(labels("opengeni mcp")[0]).toBe("Opengeni MCP server");
  });

  test("ranks the name over other words, and every word must match", () => {
    expect(labels("api keys")[0]).toBe("API keys");
    expect(labels("voice")).toEqual(["Voice input", "Default voice model", "ElevenLabs"]);
    expect(labels("transcription")).toEqual(["Voice input"]);
    expect(labels("password")[0]).toBe("Password");
    expect(labels("passkeys")[0]).toBe("Passkeys");
    expect(labels("elevenlabs")).toEqual(["ElevenLabs"]);
    expect(labels("models claude")).toEqual(["Models"]);
    expect(labels("voice billing")).toEqual([]);
  });

  test("ignores case, accents and punctuation; an empty query finds nothing", () => {
    expect(labels("  VOICE-input ")).toEqual(["Voice input"]);
    expect(labels("sécurité")).toEqual([]);
    expect(labels("Sécurity")).toContain("Security");
    expect(labels("   ")).toEqual([]);
  });

  test("in the desktop app, dictation finds the shortcut setting first", () => {
    const desktop: SettingsRailSection[] = [
      {
        id: "workspace",
        label: "Workspace",
        groups: [
          {
            items: [
              {
                id: "workspace:general",
                label: "General",
                icon: SlidersHorizontalIcon,
                link: link({ section: "general" }),
              },
              {
                id: "workspace:/workspaces/$workspaceId/computer-use",
                label: "Computer use",
                icon: MonitorIcon,
                link: link({}),
              },
            ],
          },
        ],
      },
    ];
    const found = (query: string) =>
      searchSettings(settingsSearchEntries(desktop), query).map(
        (entry) => `${entry.label} (${entry.location})`,
      );
    expect(found("dictation")).toEqual([
      "Dictation (Workspace · Computer use)",
      "Voice input (Workspace · General)",
      "Computer use (Workspace)",
    ]);
    expect(found("hotkey")[0]).toBe("Dictation (Workspace · Computer use)");
    expect(found("vocabulary")).toEqual(["Dictation (Workspace · Computer use)"]);
    // Outside the desktop app there is no Computer use page, so no Dictation either.
    expect(labels("dictation")).toEqual(["Voice input"]);
  });

  describe("Security & data", () => {
    const security: SettingsRailSection[] = [
      ...SECTIONS,
      {
        id: "organization",
        label: "Organization",
        groups: [
          {
            items: [
              {
                id: "organization:security",
                label: "Security & data",
                icon: ShieldCheckIcon,
                link: link({ section: "security" }),
              },
            ],
          },
        ],
      },
    ];
    const securityEntries = settingsSearchEntries(security);
    const found = (query: string) => searchSettings(securityEntries, query);

    test("EU finds the EU-only inference switch first, by any word for it", () => {
      for (const query of [
        "EU",
        "eu-only",
        "Europe",
        "data residency",
        "residency",
        "GDPR",
        "region",
      ]) {
        const first = found(query)[0]!;
        expect(first.label).toBe("EU-only inference");
        expect(first.location).toBe("Organization · Security & data");
        expect((first.link.props as { search: unknown }).search).toEqual({
          section: "security",
        });
      }
    });

    test("every row title on the page finds its setting first; every section title finds the page", async () => {
      const source = await Bun.file(`${import.meta.dir}/../organization/security-page.tsx`).text();
      const rows = [...source.matchAll(/<SettingRow\s+label="([^"]+)"/g)].map((match) => match[1]!);
      const sections = [...source.matchAll(/<Section\s+title="([^"]+)"/g)].map(
        (match) => match[1]!,
      );
      expect(rows).toContain("EU-only inference");
      expect(sections).toContain("Data residency");
      const inPage = (title: string) =>
        found(title)
          .filter((entry) => entry.id.split("#")[0] === "organization:security")
          .map((entry) => entry.label);
      for (const row of rows) {
        expect({ row, first: inPage(row)[0] }).toEqual({ row, first: row });
        expect(found(row)[0]?.label).toBe(row);
      }
      // Recovery's title carries an "Owners only" chip, so it isn't a plain string.
      for (const section of [...sections, "Recovery"]) {
        expect({ section, found: inPage(section).length > 0 }).toEqual({
          section,
          found: true,
        });
      }
    });
  });
});
