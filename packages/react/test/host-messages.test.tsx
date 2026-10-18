import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectController, type ConnectAttempt, type ConnectTransport } from "@opengeni/connect";
import { ConnectPanel } from "../src/connect-panel";
import { CODEX_LIVE_MODEL } from "../src/realtime/session-realtime";
import {
  createOpenGeniText,
  OpenGeniMessagesProvider,
  useOpenGeniLocale,
  useOpenGeniText,
  type OpenGeniText,
} from "../src/messages/runtime";
import { englishMessages } from "../src/messages/en";

describe("message runtime", () => {
  test("English defaults, interpolation and missing parameters", () => {
    const t = createOpenGeniText();
    expect(t("connectPanel.connections")).toBe("Connections");
    expect(t("sessionChrome.moveQueuedPromptIndexUp", { index: 3 })).toBe(
      "Move queued prompt 3 up",
    );
    expect(t.locale).toBeUndefined();
  });

  test("plural forms follow the locale's plural rules", () => {
    const en = createOpenGeniText();
    expect(en("counts.agents", { count: 1 })).toBe("1 agent");
    expect(en("counts.agents", { count: 4 })).toBe("4 agents");

    // Polish has a "few" category; a host supplies only the forms it needs.
    const pl = createOpenGeniText({
      locale: "pl",
      messages: {
        "counts.agents_one": "{count} agent",
        "counts.agents_few": "{count} agentów (few)",
        "counts.agents_other": "{count} agentów",
      },
    });
    expect(pl("counts.agents", { count: 1 })).toBe("1 agent");
    expect(pl("counts.agents", { count: 3 })).toBe("3 agentów (few)");
    expect(pl("counts.agents", { count: 5 })).toBe("5 agentów");
    expect(pl.locale).toBe("pl");
  });

  test("counted text still renders without Intl.PluralRules (Hermes)", async () => {
    const original = Intl.PluralRules;
    // Hermes on React Native ships Intl without PluralRules.
    Reflect.deleteProperty(Intl, "PluralRules");
    try {
      // A fresh module instance, so no plural rules are cached from other tests.
      const freshRuntime: string = "../src/messages/runtime.tsx?without-plural-rules";
      const runtime = (await import(freshRuntime)) as typeof import("../src/messages/runtime");
      const en = runtime.createOpenGeniText();
      expect(en("counts.agents", { count: 1 })).toBe("1 agent");
      expect(en("counts.agents", { count: 0 })).toBe("0 agents");
      expect(en("counts.agents", { count: 4 })).toBe("4 agents");
      const nb = runtime.createOpenGeniText({
        locale: "nb",
        messages: {
          "counts.agents_one": "{count} agent",
          "counts.agents_other": "{count} agenter",
        },
      });
      expect(nb("counts.agents", { count: 1 })).toBe("1 agent");
      expect(nb("counts.agents", { count: 2 })).toBe("2 agenter");
    } finally {
      Object.defineProperty(Intl, "PluralRules", {
        value: original,
        writable: true,
        configurable: true,
      });
    }
  });

  test("host text wins, missing keys fall back to English", () => {
    const t = createOpenGeniText({
      locale: "nb",
      messages: { "connectPanel.connections": "Tilkoblinger" },
    });
    expect(t("connectPanel.connections")).toBe("Tilkoblinger");
    expect(t("counts.slides", { count: 2 })).toBe("2 slides");
  });

  test("nested providers layer: inner keys, then outer keys, then English", () => {
    const seen: { text?: OpenGeniText; locale?: string | undefined } = {};
    function Probe() {
      seen.text = useOpenGeniText();
      seen.locale = useOpenGeniLocale();
      return null;
    }
    renderToStaticMarkup(
      <OpenGeniMessagesProvider
        locale="nb"
        messages={{
          "connectPanel.connections": "Tilkoblinger",
          "counts.slides_one": "{count} lysbilde",
          "counts.slides_other": "{count} lysbilder",
        }}
      >
        <OpenGeniMessagesProvider messages={{ "connectPanel.connections": "Kontoer" }}>
          <Probe />
        </OpenGeniMessagesProvider>
      </OpenGeniMessagesProvider>,
    );
    const t = seen.text!;
    expect(t("connectPanel.connections")).toBe("Kontoer");
    expect(t("counts.slides", { count: 2 })).toBe("2 lysbilder");
    expect(t("counts.sheets", { count: 1 })).toBe("1 sheet");
    expect(seen.locale).toBe("nb");
    expect(t.locale).toBe("nb");
  });
});

describe("English catalog", () => {
  const entries = Object.entries(englishMessages) as [string, string][];

  test("every plural has an _other form and no bare base key", () => {
    const keys = new Set(entries.map(([key]) => key));
    for (const [key] of entries) {
      const plural = /^(.*)_(zero|one|two|few|many|other)$/.exec(key);
      if (!plural) continue;
      expect(keys.has(`${plural[1]}_other`)).toBe(true);
      expect(keys.has(plural[1]!)).toBe(false);
    }
  });

  test("plural forms agree on their parameters", () => {
    const params = (text: string) =>
      [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const [key, text] of entries) {
      const plural = /^(.*)_(zero|one|two|few|many)$/.exec(key);
      if (!plural) continue;
      const other = (englishMessages as Record<string, string>)[`${plural[1]}_other`]!;
      expect(params(text).filter((name) => name !== "count")).toEqual(
        params(other).filter((name) => name !== "count"),
      );
    }
  });

  test("values are non-empty", () => {
    for (const [, text] of entries) expect(text.length).toBeGreaterThan(0);
  });

  test("every key is still used by the web or native components", () => {
    // The catalog is shared by @opengeni/react and @opengeni/react-native.
    const roots = [
      join(import.meta.dir, "../src"),
      join(import.meta.dir, "../../react-native/src"),
    ];
    const used = new Set<string>();
    for (const root of roots) {
      for (const file of new Bun.Glob("**/*.{ts,tsx}").scanSync(root)) {
        if (file === join("messages", "en.ts")) continue;
        const source = readFileSync(join(root, file), "utf8");
        for (const match of source.matchAll(/["'`]([A-Za-z0-9_.]+)["'`]/g)) used.add(match[1]!);
      }
    }
    const unused = entries
      .map(([key]) => key)
      .filter(
        (key) => !used.has(key) && !used.has(key.replace(/_(zero|one|two|few|many|other)$/, "")),
      );
    expect(unused).toEqual([]);
  });
});

describe("components read host text", () => {
  async function renderConnectPanel(wrap: (node: React.ReactNode) => React.ReactNode) {
    const attempt: ConnectAttempt = {
      id: "attempt",
      workspaceId: "workspace",
      providerId: "provider",
      ownership: "personal",
      revision: 1,
      state: "requires_user_action",
      credentialsCommitted: false,
      integrationInstalled: false,
      completionRequirement: "connection",
      expiresAt: "2030-01-01T00:00:00Z",
      nextAction: { type: "authorize", url: "https://provider.example/authorize" },
    };
    const transport: ConnectTransport = {
      catalog: async () => [],
      accounts: async () => [],
      pending: async () => [],
      begin: async () => attempt,
      get: async () => attempt,
      advance: async () => attempt,
      cancel: async () => attempt,
      disconnect: async () => {},
    };
    const controller = new ConnectController(transport, "workspace");
    await controller.recover(attempt.id);
    try {
      return renderToStaticMarkup(
        wrap(
          <ConnectPanel
            controller={controller}
            returnUrl="https://host.example/settings"
            onAuthorize={() => {}}
          />,
        ),
      );
    } finally {
      controller.dispose();
    }
  }

  test("the connect panel heading comes from the host catalog", async () => {
    expect(await renderConnectPanel((node) => node)).toContain("<h2>Connections</h2>");
    const html = await renderConnectPanel((node) => (
      <OpenGeniMessagesProvider messages={{ "connectPanel.connections": "Tilkoblinger" }}>
        {node}
      </OpenGeniMessagesProvider>
    ));
    expect(html).toContain("<h2>Tilkoblinger</h2>");
    expect(html).not.toContain("Connections");
  });

  test("the realtime model a host offers is labelled in the host's words", () => {
    expect(CODEX_LIVE_MODEL(createOpenGeniText()).label).toBe("Codex Live");
    const model = CODEX_LIVE_MODEL(
      createOpenGeniText({ messages: { "realtime.sessionRealtime.codexLive": "Samtale" } }),
    );
    expect(model.label).toBe("Samtale");
    // The id stays a stable wire value regardless of language.
    expect(model.id).toBe(CODEX_LIVE_MODEL(createOpenGeniText()).id);
  });
});
