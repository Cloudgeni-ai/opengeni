import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import {
  BotIcon,
  KeyRoundIcon,
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
    expect(labels("voice")).toEqual(["Voice input"]);
    expect(labels("transcription")).toEqual(["Voice input"]);
    expect(labels("password")[0]).toBe("Password");
    expect(labels("models claude")).toEqual(["Models"]);
    expect(labels("voice billing")).toEqual([]);
  });

  test("ignores case, accents and punctuation; an empty query finds nothing", () => {
    expect(labels("  VOICE-input ")).toEqual(["Voice input"]);
    expect(labels("sécurité")).toEqual([]);
    expect(labels("Sécurity")).toContain("Security");
    expect(labels("   ")).toEqual([]);
  });
});
