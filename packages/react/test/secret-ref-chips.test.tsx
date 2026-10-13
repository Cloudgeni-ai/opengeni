import { afterEach, describe, expect, test } from "bun:test";
import { parseSecretReference, tokenizeSecretText } from "@opengeni/contracts";
import type { SessionEvent, ToolActionReview } from "@opengeni/sdk";
import type { ReactNode } from "react";
import { flush, registerDom, renderComponent, type RenderedComponent } from "./render-hook";

registerDom();

// Radix picks its layout-effect implementation at import time: load after the DOM exists.
const { ApprovalSurface, MessageTimeline, SecretRefChip, SecretRefText, SecretsUiProvider } =
  await import("../src");
const { Markdown } = await import("../src/components/markdown");
const { PayloadBlock, TermBlock } = await import("../src/timeline/shared");
const { ToolActionReviewCard } = await import("../src/components/tool-action-review");
const { secretReferenceLabel, secretReferenceLabelText } =
  await import("../src/secret-reference-label");

type Ui = {
  tokenize: typeof tokenizeSecretText;
  generatePassword: () => string;
  hrefForReference?: (reference: { raw: string }) => string | null;
};

const ui: Ui = { tokenize: tokenizeSecretText, generatePassword: () => "unused" };
const linkingUi: Ui = {
  ...ui,
  hrefForReference: (reference) => `/secrets/items?ref=${encodeURIComponent(reference.raw)}`,
};

let mounted: RenderedComponent | null = null;

afterEach(async () => {
  if (!mounted) return;
  const current = mounted;
  mounted = null;
  await current.unmount();
});

async function render(node: ReactNode, value: Ui | null = ui): Promise<HTMLElement> {
  mounted = await renderComponent(
    value ? <SecretsUiProvider value={value}>{node}</SecretsUiProvider> : node,
  );
  await flush();
  return mounted.container;
}

function chips(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>("[data-og-secret-ref]")];
}

function label(raw: string): string {
  return secretReferenceLabelText(parseSecretReference(raw));
}

describe("secret reference labels", () => {
  test("path, id, one-time code, previous and file forms", () => {
    expect(label("{{secret:GitHub}}")).toBe("GitHub");
    expect(label("{{secret:GitHub/password}}")).toBe("GitHub · password");
    expect(label("{{secret:Private/GitHub/password}}")).toBe("GitHub · password");
    expect(label("{{secret:GitHub/otp}}")).toBe("GitHub · one-time code");
    // Two segments are Item/field or Vault/Item (resolved server-side), so both show.
    expect(label("{{secret:Private/GitHub/otp}}")).toBe("Private · GitHub · one-time code");
    expect(label("{{secret:Private/GitHub/totp/otp}}")).toBe("GitHub · totp · one-time code");
    expect(label("{{secret:GitHub/password#previous}}")).toBe("GitHub · password (previous)");
    expect(label("{{secret:id:6f1c1b8e-3b1a-4c55-9a51-0d0c8f2e7d11/api_key}}")).toBe(
      "Secret · api_key",
    );
    expect(label("{{secret:id:6f1c1b8e-3b1a-4c55-9a51-0d0c8f2e7d11}}")).toBe("Secret");
    expect(label("{{secretfile:Deploy/kubeconfig}}")).toBe("Deploy · kubeconfig");
    // The name truncates; the field and markers never do.
    expect(secretReferenceLabel(parseSecretReference("{{secret:GitHub/otp#previous}}"))).toEqual({
      primary: "GitHub",
      suffix: " · one-time code (previous)",
    });
  });
});

describe("SecretRefChip and SecretRefText", () => {
  test("a chip shows a lock, the label and the full reference on hover", async () => {
    const container = await render(
      <SecretRefChip reference={parseSecretReference("{{secret:Private/GitHub/password}}")} />,
    );
    const [chip] = chips(container);
    expect(chip?.tagName).toBe("SPAN");
    expect(chip?.getAttribute("title")).toBe("{{secret:Private/GitHub/password}}");
    expect(chip?.textContent).toBe("Secret: GitHub · password");
    expect(chip?.querySelector(".sr-only")?.textContent).toBe("Secret: ");
    expect(chip?.querySelector("svg.lucide-lock")).not.toBeNull();
    // Not a link, so not in the tab order.
    expect(chip?.hasAttribute("tabindex")).toBe(false);
  });

  test("a secret file uses the file glyph", async () => {
    const container = await render(
      <SecretRefChip reference={parseSecretReference("{{secretfile:Deploy/kubeconfig}}")} />,
    );
    expect(chips(container)[0]?.querySelector("svg.lucide-file-lock")).not.toBeNull();
    expect(chips(container)[0]?.querySelector(".sr-only")?.textContent).toBe("Secret file: ");
  });

  test("long names truncate while the field stays readable", async () => {
    const long = "A".repeat(110);
    const container = await render(<SecretRefText text={`{{secret:${long}/password}}`} />);
    const [chip] = chips(container);
    const name = [...chip!.querySelectorAll("span")].find((span) =>
      span.className.includes("truncate"),
    );
    expect(name?.textContent).toBe(long);
    expect(name?.className).toContain("max-w-[18em]");
    expect(chip?.textContent).toContain(" · password");
  });

  test("text keeps its words around chips; malformed references stay plain text", async () => {
    const text =
      "Log in with {{secret:GitHub/password}} and {{secret:GitHub/otp}}, not {{secret:}} or {{secret:a/b/c/d}}.";
    const container = await render(<SecretRefText text={text} />);
    expect(chips(container).map((chip) => chip.getAttribute("data-og-secret-ref"))).toEqual([
      "{{secret:GitHub/password}}",
      "{{secret:GitHub/otp}}",
    ]);
    expect(container.textContent).toContain("Log in with ");
    expect(container.textContent).toContain("not {{secret:}} or {{secret:a/b/c/d}}.");
  });

  test("only malformed or no references: the text is returned unchanged", async () => {
    const container = await render(<SecretRefText text="Broken {{secret:}} here" />);
    expect(chips(container)).toEqual([]);
    expect(container.innerHTML).toBe("Broken {{secret:}} here");
  });

  test("without a provider the text is unchanged", async () => {
    const container = await render(<SecretRefText text="Use {{secret:GitHub/password}}" />, null);
    expect(chips(container)).toEqual([]);
    expect(container.textContent).toBe("Use {{secret:GitHub/password}}");
  });

  test("a chip links only when the host provides a target and linking is allowed", async () => {
    const container = await render(
      <>
        <SecretRefText text="{{secret:GitHub/password}}" />
        <SecretRefText text="{{secret:GitHub/password}}" linkable={false} />
      </>,
      linkingUi,
    );
    const [linked, plain] = chips(container);
    expect(linked?.tagName).toBe("A");
    expect(linked?.getAttribute("href")).toBe(
      "/secrets/items?ref=%7B%7Bsecret%3AGitHub%2Fpassword%7D%7D",
    );
    expect(plain?.tagName).toBe("SPAN");
  });
});

describe("chips in Markdown", () => {
  const source = [
    "Saved as {{secret:GitHub/password}} in **{{secret:Private/GitHub/otp}}**.",
    "",
    "- item {{secret:Stripe/api_key}}",
    "",
    "Inline `{{secret:Inline/token}}` and mixed `export T={{secret:Mixed/token}}`.",
    "",
    "[link {{secret:Link/token}}](https://example.com)",
    "",
    "Broken {{secret:}} stays text.",
    "",
    "```sh",
    "curl -H {{secret:Fenced/token}}",
    "```",
  ].join("\n");

  test("prose and whole-reference inline code chip; code, links and malformed stay literal", async () => {
    const container = await render(<Markdown>{source}</Markdown>);
    expect(chips(container).map((chip) => chip.getAttribute("data-og-secret-ref"))).toEqual([
      "{{secret:GitHub/password}}",
      "{{secret:Private/GitHub/otp}}",
      "{{secret:Stripe/api_key}}",
      "{{secret:Inline/token}}",
    ]);
    expect(container.querySelector("strong [data-og-secret-ref]")).not.toBeNull();
    expect(container.querySelector("li [data-og-secret-ref]")).not.toBeNull();
    expect(container.querySelector("pre")?.textContent).toContain("{{secret:Fenced/token}}");
    expect(container.querySelector("a")?.textContent).toBe("link {{secret:Link/token}}");
    expect(container.textContent).toContain("export T={{secret:Mixed/token}}");
    expect(container.textContent).toContain("Broken {{secret:}} stays text.");
  });

  test("without a provider Markdown renders references as written", async () => {
    const container = await render(<Markdown>{source}</Markdown>, null);
    expect(chips(container)).toEqual([]);
    expect(container.textContent).toContain("Saved as {{secret:GitHub/password}}");
  });
});

describe("chips in tool payloads, commands and reviews", () => {
  test("tool-argument JSON keeps its text and chips the references", async () => {
    const container = await render(
      <PayloadBlock
        label="Arguments"
        value={{ url: "https://api.example.com", token: "{{secret:Stripe/api_key}}" }}
      />,
    );
    const pre = container.querySelector("pre")!;
    expect(chips(pre).map((chip) => chip.textContent)).toEqual(["Secret: Stripe · api_key"]);
    expect(pre.textContent).toContain('"url": "https://api.example.com"');
    expect(pre.textContent).toContain('"token": "');
  });

  test("a terminal command chips references", async () => {
    const container = await render(
      <TermBlock command="gh auth login --with-token {{secret:GitHub/token}}" output="" />,
    );
    expect(chips(container).map((chip) => chip.getAttribute("data-og-secret-ref"))).toEqual([
      "{{secret:GitHub/token}}",
    ]);
  });

  test("an exec row title chips the command's references without nesting a link", async () => {
    let sequence = 0;
    const event = (type: string, payload: unknown): SessionEvent => {
      sequence += 1;
      return {
        id: `chip-evt-${sequence}`,
        workspaceId: "ws-1",
        sessionId: "session-1",
        sequence,
        type,
        payload,
        occurredAt: new Date(1718000000000 + sequence * 1000).toISOString(),
        turnId: "turn-1",
      };
    };
    const container = await render(
      <MessageTimeline
        events={[
          event("user.message", { text: "Deploy with {{secret:Deploy/token}} please" }),
          event("agent.toolCall.created", {
            id: "exec-1",
            name: "exec_command",
            arguments: { cmd: "deploy --token {{secret:Deploy/token}}" },
          }),
          event("agent.toolCall.output", { id: "exec-1", output: "ok" }),
        ]}
      />,
      linkingUi,
    );
    const refs = chips(container).map((chip) => chip.getAttribute("data-og-secret-ref"));
    // The user message and the exec row title.
    expect(refs.filter((ref) => ref === "{{secret:Deploy/token}}").length).toBeGreaterThanOrEqual(
      2,
    );
    // No chip inside a button or a link is itself a link.
    for (const chip of chips(container)) {
      if (chip.closest("button, [role='button']")) expect(chip.tagName).toBe("SPAN");
    }
  });

  test("review card fields chip references; inside the field button they never link", async () => {
    const review: ToolActionReview = {
      version: 1,
      id: "approval-1",
      actionDigest: "digest",
      revision: "revision-1",
      status: "pending",
      title: "Call Stripe",
      effects: [],
      samples: [],
      fields: [
        { label: "Token", path: "token", preview: "Bearer {{secret:Stripe/api_key}}" },
        {
          label: "Body",
          path: "body",
          preview: "{{secret:Stripe/webhook_secret}}",
          truncated: true,
        },
      ],
      moreFields: 0,
      reason: "Review this change.",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      approveLabel: "Approve action",
      availableActions: ["approve", "reject"],
      detailsAvailable: true,
    } as unknown as ToolActionReview;
    const container = await render(
      <ToolActionReviewCard
        review={review}
        onApprove={() => undefined}
        onReject={() => undefined}
        onViewDetails={() => undefined}
      />,
      linkingUi,
    );
    const found = chips(container);
    expect(found.map((chip) => chip.getAttribute("data-og-secret-ref"))).toEqual([
      "{{secret:Stripe/api_key}}",
      "{{secret:Stripe/webhook_secret}}",
    ]);
    expect(found[0]?.tagName).toBe("A");
    expect(found[1]?.closest("button")).not.toBeNull();
    expect(found[1]?.tagName).toBe("SPAN");
    expect(container.textContent).toContain("Bearer ");
  });

  test("an approval built from raw arguments chips references", async () => {
    const container = await render(
      <ApprovalSurface
        approvals={[
          {
            id: "approval-raw",
            name: "github.create_deploy_key",
            arguments: { repository: "acme/widget", key: "{{secret:Deploy/public_key}}" },
          },
        ]}
        onApprove={() => undefined}
        onReject={() => undefined}
      />,
    );
    expect(chips(container).map((chip) => chip.getAttribute("data-og-secret-ref"))).toContain(
      "{{secret:Deploy/public_key}}",
    );
  });
});
