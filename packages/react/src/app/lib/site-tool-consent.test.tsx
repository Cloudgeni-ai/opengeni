import { describe, expect, test } from "bun:test";
import type { SiteToolConsentDecision, SiteToolConsentPrompt } from "@opengeni/sdk/site";
import { actRun, flush, registerDom, renderComponent } from "../../../test/render-hook";
import type { SiteToolConsentHost } from "./site-tool-consent";

registerDom();
// Radix chooses its layout effect when it is imported: import after the DOM.
const { SiteToolConsentProvider, useSiteToolConsentHost } = await import("./site-tool-consent");
const { CONFIRM_ARM_MS, siteToolConsentSummary } = await import("./site-tool-consent-dialog");

const work = { serverId: "account-work", toolName: "send_message" };
const home = { serverId: "account-home", toolName: "send_message" };
function prompt(
  overrides: Partial<SiteToolConsentPrompt> = {},
  signal = new AbortController().signal,
): SiteToolConsentPrompt {
  return {
    tool: {
      version: 1,
      entry: { identity: work, title: "Send message" },
      definitionDigest: "d".repeat(64),
    } as unknown as SiteToolConsentPrompt["tool"],
    arguments: {
      to: ["bendik@cloudgeni.ai"],
      cc: "ops@example.test",
      subject: "Opengeni newsletter",
      body: "never shown",
    },
    accounts: [
      { identity: work, connector: "Gmail", account: "ada@work.example" },
      { identity: home, connector: "Gmail", account: "ada@home.example" },
    ],
    selected: work,
    review: null,
    reviewFor: async () => null,
    signal,
    ...overrides,
  };
}

async function mount() {
  let host: SiteToolConsentHost | null = null;
  function Capture() {
    host = useSiteToolConsentHost();
    return null;
  }
  const view = await renderComponent(
    <SiteToolConsentProvider>
      <Capture />
    </SiteToolConsentProvider>,
  );
  return { view, host: () => host! };
}
const dialog = () => document.body.querySelector<HTMLElement>("[role=dialog]");
async function waitFor(condition: () => boolean, message: string) {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(message);
    await flush(10);
  }
}
const opened = () => waitFor(() => dialog() !== null, "the confirmation did not open");
const closed = () => waitFor(() => dialog() === null, "the confirmation did not close");
const button = (label: string) =>
  [...(dialog()?.querySelectorAll("button") ?? [])].find(
    (candidate) => candidate.textContent?.trim() === label,
  )!;

describe("Site tool consent dialog", () => {
  test("says what will happen, from which account and to whom", () => {
    expect(siteToolConsentSummary(prompt())).toEqual({
      title: "Send message",
      consequence: null,
      confirmLabel: "Send",
      rows: [
        { label: "To", value: "bendik@cloudgeni.ai" },
        { label: "Cc", value: "ops@example.test" },
        { label: "Subject", value: "Opengeni newsletter" },
      ],
    });
    expect(
      siteToolConsentSummary(
        prompt({
          tool: {
            version: 1,
            entry: { identity: { serverId: "linear", toolName: "create_issue" } },
            definitionDigest: "d".repeat(64),
          } as unknown as SiteToolConsentPrompt["tool"],
          arguments: {},
        }),
      ),
    ).toEqual({ title: "Create issue", consequence: null, confirmLabel: "Confirm", rows: [] });
  });

  test("a provider review replaces what the Site's arguments claim", () => {
    // Site code sends a raw message (or a draft, or a reply): its top-level
    // fields say nothing, or something else. Gmail's own reading decides.
    const raw = prompt({
      arguments: { raw: "VG86IGFueW9uZUBleGFtcGxlLnRlc3Q", to: "decoy@example.test" },
    });
    expect(
      siteToolConsentSummary(raw, {
        kind: "gmail",
        email: {
          from: "ada@work.example",
          to: "anyone@example.test",
          cc: "",
          bcc: "hidden@example.test",
          subject: "",
          attachments: 2,
        },
      }),
    ).toEqual({
      title: "Send email",
      consequence: null,
      confirmLabel: "Send",
      rows: [
        { label: "To", value: "anyone@example.test" },
        { label: "Bcc", value: "hidden@example.test" },
        { label: "Subject", value: "(No subject)" },
        { label: "Attachments", value: "2" },
      ],
    });
  });

  test("Send waits briefly after opening; another account is reviewed again", async () => {
    const { view, host } = await mount();
    try {
      const reviewed: string[] = [];
      let decision: SiteToolConsentDecision | undefined;
      await actRun(() => {
        void host()
          .confirmToolCall(
            prompt({
              review: {
                kind: "gmail",
                email: {
                  from: "ada@work.example",
                  to: "work-list@example.test",
                  cc: "",
                  bcc: "",
                  subject: "From work",
                  attachments: 0,
                },
              },
              reviewFor: async (identity) => {
                reviewed.push(identity.serverId);
                return {
                  kind: "gmail",
                  email: {
                    from: "ada@home.example",
                    to: "home-list@example.test",
                    cc: "",
                    bcc: "",
                    subject: "From home",
                    attachments: 0,
                  },
                };
              },
            }),
          )
          .then((value) => {
            decision = value;
          });
      });
      await opened();
      // Not answerable the instant a Site opens it; focus starts on Cancel.
      expect(button("Send").disabled).toBe(true);
      expect(document.activeElement?.textContent?.trim()).toBe("Cancel");
      expect(dialog()?.textContent).toContain("work-list@example.test");
      await waitFor(() => !button("Send").disabled, "Send never became available");
      const from = dialog()!.querySelector<HTMLSelectElement>("select[aria-label=From]")!;
      await actRun(() => {
        from.value = from.options[1]!.value;
        from.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await waitFor(
        () => (dialog()?.textContent ?? "").includes("home-list@example.test"),
        "the other account's review did not show",
      );
      expect(reviewed).toEqual([home.serverId]);
      expect(dialog()?.textContent).not.toContain("work-list@example.test");
      await actRun(async () => {
        button("Send").click();
        await Promise.resolve();
      });
      await closed();
      expect(decision).toEqual({ identity: home });
    } finally {
      await view.unmount();
    }
    expect(CONFIRM_ARM_MS).toBeGreaterThan(0);
  });

  test("Send answers with the chosen account and Always allow; one answer only", async () => {
    const { view, host } = await mount();
    try {
      let decision: SiteToolConsentDecision | undefined;
      let answers = 0;
      await actRun(() => {
        void host()
          .confirmToolCall(prompt())
          .then((value) => {
            answers++;
            decision = value;
          });
      });
      await opened();
      const text = dialog()?.textContent ?? "";
      expect(text).toContain("Send message");
      expect(text).toContain("bendik@cloudgeni.ai");
      expect(text).toContain("Opengeni newsletter");
      expect(text).toContain("Always allow for this Site");
      expect(text).not.toContain("never shown");
      const from = dialog()!.querySelector<HTMLSelectElement>("select[aria-label=From]")!;
      expect([...from.options].map((option) => option.textContent)).toEqual([
        "ada@work.example",
        "ada@home.example",
      ]);
      await actRun(() => {
        from.value = from.options[1]!.value;
        from.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await actRun(() => {
        dialog()!.querySelector<HTMLElement>("[role=checkbox], input[type=checkbox]")!.click();
      });
      await waitFor(() => !button("Send").disabled, "Send never became available");
      await actRun(async () => {
        button("Send").click();
        await Promise.resolve();
      });
      await closed();
      expect(decision).toEqual({ identity: home, alwaysAllow: true });
      expect(answers).toBe(1);
    } finally {
      await view.unmount();
    }
  });

  test("Cancel answers null; a Site that stops waiting withdraws the dialog", async () => {
    const { view, host } = await mount();
    try {
      let cancelled: SiteToolConsentDecision | undefined;
      await actRun(() => {
        void host()
          .confirmToolCall(prompt({ accounts: [], selected: null }))
          .then((value) => {
            cancelled = value;
          });
      });
      await opened();
      // No accounts: no From row.
      expect(dialog()?.querySelector("select")).toBeNull();
      await actRun(() => button("Cancel").click());
      await closed();
      expect(cancelled).toBeNull();

      const controller = new AbortController();
      let withdrawn: SiteToolConsentDecision | undefined;
      await actRun(() => {
        void host()
          .confirmToolCall(prompt({}, controller.signal))
          .then((value) => {
            withdrawn = value;
          });
      });
      await opened();
      await actRun(() => controller.abort());
      await closed();
      expect(withdrawn).toBeNull();
    } finally {
      await view.unmount();
    }
  });
});
