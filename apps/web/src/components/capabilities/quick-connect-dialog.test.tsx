import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

// Radix portals do not mount under happy-dom (same limitation worked around in
// use-slack-integration.test.tsx): render the dialog frame inline so the real
// field/submit/error body can be exercised. The captured `onOpenChange` is the
// exact, unwrapped prop QuickConnectDialog passes to Dialog - since the
// component adds no onPointerDownOutside/onEscapeKeyDown override, calling it
// directly is equivalent to Radix invoking it on an outside click, including
// while a connect is in flight.
let capturedOnOpenChange: ((open: boolean) => void) | null = null;
mock.module("@/components/ui/dialog", () => ({
  Dialog: ({
    open,
    onOpenChange,
    children,
  }: {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    children?: React.ReactNode;
  }) => {
    capturedOnOpenChange = onOpenChange ?? null;
    return open ? <div data-dialog>{children}</div> : null;
  },
  DialogContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children?: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children?: React.ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children?: React.ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children?: React.ReactNode }) => <h2>{children}</h2>,
}));

const { QuickConnectDialog } = await import("./quick-connect-dialog");
type QuickConnectRequest = Parameters<typeof QuickConnectDialog>[0]["request"];

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

// happy-dom's native "input" event does not reach React's delegated listener
// reliably in this harness, so a dispatched event never flips controlled
// state (same limitation worked around in documents.test.tsx's
// setControlledInput): set the DOM value then invoke the fiber's own
// onChange prop directly.
function typeInto(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  const reactPropsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
  const onChange = (
    input as unknown as Record<string, { onChange?: (event: { target: HTMLInputElement }) => void }>
  )[reactPropsKey!]!.onChange;
  onChange!({ target: input });
}

async function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe("QuickConnectDialog", () => {
  test("api_key: exactly one field, no scope bullet list, submits the trimmed value", async () => {
    const onConnect = mock(async (_value: string) => {});
    const onOpenChange = mock((_open: boolean) => {});
    const request: QuickConnectRequest = {
      authKind: "api_key",
      itemName: "Acme API",
      providerDomain: "acme.example",
      fieldLabel: "API key",
      onConnect,
    };
    const rendered = await render(
      <QuickConnectDialog request={request} onOpenChange={onOpenChange} />,
    );
    try {
      expect(rendered.container.textContent).not.toContain("scope");
      const input = rendered.container.querySelector<HTMLInputElement>("#quick-connect-value")!;
      expect(input).not.toBeNull();
      await act(async () => typeInto(input, "  secret-token  "));
      const submit = [...rendered.container.querySelectorAll("button")].find(
        (node) => node.textContent?.trim() === "Connect",
      )!;
      await act(async () => submit.click());
      expect(onConnect).toHaveBeenCalledWith("secret-token");
      expect(onOpenChange).toHaveBeenCalledWith(false);
    } finally {
      await rendered.unmount();
    }
  });

  test("oauth2_unreviewed: one line naming the domain, no field, no confirmation form", async () => {
    const onConnect = mock(async () => {});
    const request: QuickConnectRequest = {
      authKind: "oauth2_unreviewed",
      itemName: "Untrusted Connector",
      providerDomain: "untrusted.example",
      onConnect,
    };
    const rendered = await render(<QuickConnectDialog request={request} onOpenChange={() => {}} />);
    try {
      expect(rendered.container.querySelector("#quick-connect-value")).toBeNull();
      expect(rendered.container.textContent).toContain("You'll sign in at untrusted.example.");
      const submit = [...rendered.container.querySelectorAll("button")].find(
        (node) => node.textContent?.trim() === "Connect",
      )!;
      await act(async () => submit.click());
      expect(onConnect).toHaveBeenCalledTimes(1);
    } finally {
      await rendered.unmount();
    }
  });

  test("closes on outside click even mid-submission: no onOpenChange override, unlike the old dialog", async () => {
    const onOpenChange = mock((_open: boolean) => {});
    let resolveConnect: (() => void) | undefined;
    const request: QuickConnectRequest = {
      authKind: "api_key",
      itemName: "Acme API",
      providerDomain: "acme.example",
      fieldLabel: "API key",
      onConnect: () =>
        new Promise<void>((resolve) => {
          resolveConnect = resolve;
        }),
    };
    const rendered = await render(
      <QuickConnectDialog request={request} onOpenChange={onOpenChange} />,
    );
    try {
      const input = rendered.container.querySelector<HTMLInputElement>("#quick-connect-value")!;
      await act(async () => typeInto(input, "token"));
      const submit = [...rendered.container.querySelectorAll("button")].find(
        (node) => node.textContent?.trim() === "Connect",
      )!;
      // Start the submit but leave it pending (busy), then simulate Radix
      // calling onOpenChange(false) on an outside click. QuickConnectDialog
      // forwards this straight through with no override, unlike the deleted
      // IntegrationConnectDialog's onPointerDownOutside/onEscapeKeyDown guard.
      await act(async () => {
        submit.click();
      });
      expect(capturedOnOpenChange).toBe(onOpenChange);
      act(() => capturedOnOpenChange!(false));
      expect(onOpenChange).toHaveBeenCalledWith(false);
      await act(async () => resolveConnect?.());
    } finally {
      await rendered.unmount();
    }
  });

  test("a failed connect keeps the dialog open and shows the error, submit re-enabled", async () => {
    const onOpenChange = mock((_open: boolean) => {});
    const request: QuickConnectRequest = {
      authKind: "api_key",
      itemName: "Acme API",
      providerDomain: "acme.example",
      fieldLabel: "API key",
      onConnect: async () => {
        throw new Error("The key was rejected.");
      },
    };
    const rendered = await render(
      <QuickConnectDialog request={request} onOpenChange={onOpenChange} />,
    );
    try {
      const input = rendered.container.querySelector<HTMLInputElement>("#quick-connect-value")!;
      await act(async () => typeInto(input, "bad-token"));
      const submit = [...rendered.container.querySelectorAll("button")].find(
        (node) => node.textContent?.trim() === "Connect",
      )!;
      await act(async () => submit.click());
      expect(rendered.container.textContent).toContain("The key was rejected.");
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(submit.hasAttribute("disabled")).toBe(false);
    } finally {
      await rendered.unmount();
    }
  });
});
