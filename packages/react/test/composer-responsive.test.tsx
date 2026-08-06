import { afterEach, describe, expect, test } from "bun:test";
import { act, type CSSProperties } from "react";

import { ChatComposer } from "../src/components/chat-composer";
import { ModelPolicyPicker } from "../src/components/model-policy-picker";
import type { ComposerState } from "../src/hooks/use-composer";
import {
  PORTAL_SOURCE_INLINE_SIZE,
  usePortalTokenSource,
  usePortalTokenStyle,
} from "../src/lib/use-portal-token-style";
import { registerDom, renderComponent, type RenderedComponent } from "./render-hook";

registerDom();

let mounted: RenderedComponent | null = null;

class ControlledResizeObserver implements ResizeObserver {
  static instances: ControlledResizeObserver[] = [];

  readonly observed = new Set<Element>();
  disconnected = false;

  constructor(private readonly callback: ResizeObserverCallback) {
    ControlledResizeObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.observed.add(target);
  }

  unobserve(target: Element): void {
    this.observed.delete(target);
  }

  disconnect(): void {
    this.disconnected = true;
    this.observed.clear();
  }

  emit(): void {
    this.callback([], this);
  }
}

afterEach(async () => {
  if (mounted) {
    const current = mounted;
    mounted = null;
    await current.unmount();
  }
  ControlledResizeObserver.instances = [];
});

function composer(): ComposerState {
  return {
    value: "",
    setValue: () => {},
    hasDraftContent: () => false,
    send: async () => true,
    steer: async () => true,
    sending: false,
    canSend: false,
    pause: async () => {},
    pausing: false,
    resume: async () => {},
    resumeScope: async () => {},
    resuming: false,
    draft: null,
    draftRevision: 0,
    draftLoading: false,
    draftSaving: false,
    draftConflict: null,
    applyDraft: () => {},
    reloadDraft: async () => {},
    resolveDraftConflict: async () => {},
    restoredResources: [],
    removeRestoredResource: () => {},
    error: null,
    clearError: () => {},
  };
}

function picker(loading = false) {
  return (
    <ModelPolicyPicker
      rows={[]}
      defaultOpen
      loading={loading}
      model="codex/example-with-a-long-name"
      effort="medium"
      latencyMode="standard"
      onModelChange={() => {}}
      onEffortChange={() => {}}
      onLatencyModeChange={() => {}}
    />
  );
}

function PortalStyleProbe({ alternate = false }: { alternate?: boolean }) {
  const source = usePortalTokenSource<HTMLButtonElement>();
  const style = usePortalTokenStyle(source.source);
  return (
    <>
      <button
        key={alternate ? "alternate" : "initial"}
        ref={source.ref}
        type="button"
        data-portal-source
        style={
          {
            "--og-source-version": alternate ? "alternate" : "initial",
          } as CSSProperties
        }
      >
        portal source
      </button>
      <span data-portal-style style={style} />
    </>
  );
}

describe("container-responsive composer", () => {
  test("keeps the historical viewport basis when the new prop is omitted", async () => {
    globalThis.ResizeObserver = ControlledResizeObserver;
    mounted = await renderComponent(
      <ChatComposer
        composer={composer()}
        controlsStart={picker()}
        actionsStart={<span>extra</span>}
      />,
    );

    const root = mounted.container.querySelector<HTMLElement>(".og-composer");
    expect(root?.dataset.ogResponsiveBasis).toBe("viewport");
    expect(root?.classList.contains("og-root")).toBe(true);
    expect(root?.querySelector(".og-composer-input")).not.toBeNull();
    expect(root?.querySelector(".og-composer-footer[data-og-stack-actions]")).not.toBeNull();
    expect(ControlledResizeObserver.instances).toHaveLength(0);
  });

  test("tracks the actual composer width for portalled tokens and disconnects cleanly", async () => {
    globalThis.ResizeObserver = ControlledResizeObserver;
    mounted = await renderComponent(
      <ChatComposer
        composer={composer()}
        responsiveBasis="container"
        controlsStart={<PortalStyleProbe />}
      />,
    );

    const root = mounted.container.querySelector<HTMLElement>(".og-composer");
    const trigger = mounted.container.querySelector<HTMLButtonElement>("[data-portal-source]");
    expect(root?.dataset.ogResponsiveBasis).toBe("container");
    expect(ControlledResizeObserver.instances).toHaveLength(1);
    expect(ControlledResizeObserver.instances[0]?.observed.has(root!)).toBe(true);

    let inlineSize = 320;
    Object.defineProperty(root, "clientWidth", {
      configurable: true,
      get: () => inlineSize,
    });
    trigger?.style.setProperty("--og-test-portal-token", "container-value");

    await act(async () => {
      ControlledResizeObserver.instances[0]?.emit();
      await Promise.resolve();
    });

    const content = mounted.container.querySelector<HTMLElement>("[data-portal-style]");
    expect(content?.style.getPropertyValue(PORTAL_SOURCE_INLINE_SIZE)).toBe("320px");
    expect(content?.style.getPropertyValue("--og-test-portal-token")).toBe("container-value");

    inlineSize = 420;
    await act(async () => {
      ControlledResizeObserver.instances[0]?.emit();
      await Promise.resolve();
    });
    expect(content?.style.getPropertyValue(PORTAL_SOURCE_INLINE_SIZE)).toBe("420px");

    const observer = ControlledResizeObserver.instances[0]!;
    const current = mounted;
    mounted = null;
    await current.unmount();
    expect(observer.disconnected).toBe(true);
  });

  test("starts observing when ModelPolicyPicker changes from loading to ready", async () => {
    globalThis.ResizeObserver = ControlledResizeObserver;
    mounted = await renderComponent(
      <ChatComposer
        composer={composer()}
        responsiveBasis="container"
        controlsStart={picker(true)}
      />,
    );

    const root = mounted.container.querySelector<HTMLElement>(".og-composer")!;
    expect(mounted.container.querySelector('[aria-label="Model and effort"]')).toBeNull();
    expect(ControlledResizeObserver.instances).toHaveLength(0);
    Object.defineProperty(root, "clientWidth", { configurable: true, value: 336 });

    await mounted.rerender(
      <ChatComposer
        composer={composer()}
        responsiveBasis="container"
        controlsStart={picker(false)}
      />,
    );

    expect(mounted.container.querySelector('[aria-label="Model and effort"]')).not.toBeNull();
    expect(ControlledResizeObserver.instances).toHaveLength(1);
    expect(ControlledResizeObserver.instances[0]?.observed.has(root)).toBe(true);
  });

  test("restarts observation when the source element is replaced", async () => {
    globalThis.ResizeObserver = ControlledResizeObserver;
    mounted = await renderComponent(
      <ChatComposer
        composer={composer()}
        responsiveBasis="container"
        controlsStart={<PortalStyleProbe />}
      />,
    );
    const initialObserver = ControlledResizeObserver.instances[0]!;
    expect(
      mounted.container
        .querySelector<HTMLElement>("[data-portal-style]")
        ?.style.getPropertyValue("--og-source-version"),
    ).toBe("initial");

    await mounted.rerender(
      <ChatComposer
        composer={composer()}
        responsiveBasis="container"
        controlsStart={<PortalStyleProbe alternate />}
      />,
    );

    expect(initialObserver.disconnected).toBe(true);
    expect(ControlledResizeObserver.instances.length).toBeGreaterThanOrEqual(2);
    expect(
      mounted.container
        .querySelector<HTMLElement>("[data-portal-style]")
        ?.style.getPropertyValue("--og-source-version"),
    ).toBe("alternate");
  });
});
