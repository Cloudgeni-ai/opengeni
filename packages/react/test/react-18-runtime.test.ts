// The package supports React 18 as well as 19 (see peerDependencies). React 18
// hands a `ref` to a function component only through `forwardRef`; a component
// that reads `ref` as a prop works on 19 alone. This file runs the embedded
// session shell's phone drawer on React 18 itself, so a ref that never reaches
// its element (the drawer's focus return, Radix's `asChild` triggers) fails here.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";

// react-dom 18 detects DOM event support once, when it loads: register the
// DOM before it does.
GlobalRegistrator.register({ width: 440, height: 800 });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// React 18 for every importer: this file, the package source and its
// dependencies (Radix, Motion). Registered before anything loads React.
const REACT_18 = [
  ["react", "react-18"],
  ["react/jsx-runtime", "react-18/jsx-runtime"],
  ["react/jsx-dev-runtime", "react-18/jsx-dev-runtime"],
  ["react-dom", "react-dom-18"],
  ["react-dom/client", "react-dom-18/client"],
  ["react-dom/server", "react-dom-18/server.browser"],
] as const;
for (const [specifier, replacement] of REACT_18) {
  const exports = require(replacement);
  mock.module(Bun.resolveSync(specifier, import.meta.dir), () => ({
    ...exports,
    default: exports,
  }));
}

const React = await import("react");
const { createRoot } = await import("react-dom/client");
// The chat list is the drawer's data, not its mechanics: keep the rest of its
// module (the New session link) and stand in for the list itself.
const sessionListPath = Bun.resolveSync("../src/app/components/rail/session-list", import.meta.dir);
const sessionList = await import(sessionListPath);
mock.module(sessionListPath, () => ({
  ...sessionList,
  SessionList: () => React.createElement("p", null, "No sessions yet"),
  CollapsedSessionsButton: () => null,
}));
const { EmbeddedSessionShell } = await import("./react-18-session-shell-fixture");

const reported: string[] = [];
const originalConsoleError = console.error;
const recordError = (event: ErrorEvent) => void reported.push(String(event.error ?? event.message));
const recordRejection = (event: PromiseRejectionEvent) => void reported.push(String(event.reason));

beforeAll(() => {
  // React 18 reports a dropped ref ("Function components cannot be given
  // refs") and other misuse through console.error; any of it fails the test.
  console.error = (...args: unknown[]) => void reported.push(args.map(String).join(" "));
  window.addEventListener("error", recordError);
  window.addEventListener("unhandledrejection", recordRejection);
});

beforeEach(() => {
  reported.length = 0;
});

afterAll(async () => {
  console.error = originalConsoleError;
  window.removeEventListener("error", recordError);
  window.removeEventListener("unhandledrejection", recordRejection);
  mock.restore();
  await GlobalRegistrator.unregister();
});

/** Lets Radix's deferred focus and dismiss handlers run. */
const settle = () => React.act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

/** The focused element by its accessible name, for readable failures. */
function focused(): string {
  const element = document.activeElement;
  if (!element || element === document.body) return "<body>";
  return element.getAttribute("aria-label") ?? element.textContent?.trim() ?? element.tagName;
}

test("runs on React 18", () => {
  expect(React.version).toStartWith("18.");
});

test("no component takes its ref as an ordinary prop, which only React 19 passes", async () => {
  // Props typed with `ComponentProps` of an element or a Radix part include
  // `ref`; a plain function component that spreads them loses it on React 18.
  // Such components take `ComponentPropsWithoutRef` and forward the ref.
  const refAsProp = [
    /\bComponentProps<"[a-z][\w-]*">/u,
    /\bComponentProps<typeof \w+Primitive\.\w+>/u,
    /function [A-Z]\w*\(\s*\{[^}]*\bref\b\s*[,}]/u,
  ];
  const offenders: string[] = [];
  for await (const path of new Bun.Glob("src/**/*.tsx").scan(`${import.meta.dir}/..`)) {
    if (path.endsWith(".test.tsx")) continue;
    const source = await Bun.file(`${import.meta.dir}/../${path}`).text();
    for (const pattern of refAsProp) {
      const match = pattern.exec(source);
      if (match) offenders.push(`${path}: ${match[0]}`);
    }
  }
  expect(offenders).toEqual([]);
});

test("the phone drawer opens, closes and reopens with focus returned and no stuck overlay", async () => {
  expect(window.innerWidth).toBe(440);
  const app = document.createElement("div");
  const overlays = document.createElement("div");
  document.body.append(app, overlays);
  const root = createRoot(app);
  await React.act(async () =>
    root.render(React.createElement(EmbeddedSessionShell, { container: overlays })),
  );

  const trigger = app.querySelector<HTMLButtonElement>('button[aria-label="Open navigation"]');
  if (!trigger) throw new Error("The phone shell has no Open navigation button");
  const drawers = () => overlays.querySelectorAll('[data-slot="sheet-content"]');
  const backdrops = () => overlays.querySelectorAll('[data-slot="sheet-overlay"]');
  const expectOpen = () => {
    expect(drawers()).toHaveLength(1);
    expect(backdrops()).toHaveLength(1);
    expect(drawers()[0]!.querySelector('[aria-label="Close navigation"]')).not.toBeNull();
    expect(drawers()[0]!.contains(document.activeElement)).toBe(true);
  };
  const expectClosed = () => {
    expect(drawers()).toHaveLength(0);
    expect(backdrops()).toHaveLength(0);
    expect(document.body.style.pointerEvents).not.toBe("none");
    // The drawer has no in-tree trigger; the shell returns focus through the
    // hamburger button's ref.
    expect(focused()).toBe("Open navigation");
    expect(document.activeElement === trigger).toBe(true);
  };

  await React.act(async () => trigger.click());
  await settle();
  expectOpen();

  const close = drawers()[0]!.querySelector<HTMLButtonElement>('[aria-label="Close navigation"]');
  await React.act(async () => close!.click());
  await settle();
  expectClosed();

  await React.act(async () => trigger.click());
  await settle();
  expectOpen();

  await React.act(async () => {
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
  await settle();
  expectClosed();

  await React.act(async () => root.unmount());
  expect(reported).toEqual([]);
});

test("shared primitives hand a ref to their element, directly and through asChild", async () => {
  const [button, input, textarea, label, badge, card, separator, skeleton, switchModule] =
    await Promise.all([
      import("../src/ui/button"),
      import("../src/ui/input"),
      import("../src/ui/textarea"),
      import("../src/ui/label"),
      import("../src/ui/badge"),
      import("../src/ui/card"),
      import("../src/ui/separator"),
      import("../src/ui/skeleton"),
      import("../src/ui/switch"),
    ]);
  const [avatar, scrollArea, field, toolbar, tooltip] = await Promise.all([
    import("../src/ui/avatar"),
    import("../src/ui/scroll-area"),
    import("../src/ui/field"),
    import("../src/ui/toolbar"),
    import("../src/ui/tooltip"),
  ]);
  const h = React.createElement;
  const primitives: Record<string, React.ElementType> = {
    Button: button.Button,
    Input: input.Input,
    Textarea: textarea.Textarea,
    Label: label.Label,
    Badge: badge.Badge,
    Card: card.Card,
    CardHeader: card.CardHeader,
    CardContent: card.CardContent,
    Separator: separator.Separator,
    Skeleton: skeleton.Skeleton,
    Switch: switchModule.Switch,
    Avatar: avatar.Avatar,
    ScrollArea: scrollArea.ScrollArea,
    TextInput: field.TextInput,
    TextArea: field.TextArea,
    Checkbox: field.Checkbox,
    Toolbar: toolbar.Toolbar,
  };
  const refs = Object.fromEntries(
    Object.keys(primitives).map((name) => [name, React.createRef<HTMLElement>()]),
  );
  // A Radix trigger composes its own ref with the child's: the tooltip
  // anchors to the element that ref reaches.
  const triggerRef = React.createRef<HTMLButtonElement>();
  const app = document.createElement("div");
  document.body.append(app);
  const root = createRoot(app);
  await React.act(async () =>
    root.render(
      h(
        tooltip.TooltipProvider,
        null,
        ...Object.entries(primitives).map(([name, Primitive]) =>
          h(Primitive, { key: name, ref: refs[name], "aria-label": name }),
        ),
        h(
          tooltip.Tooltip,
          null,
          h(
            tooltip.TooltipTrigger,
            { asChild: true },
            h(button.Button, { ref: triggerRef }, "Hover me"),
          ),
          h(tooltip.TooltipContent, null, "Tip"),
        ),
      ),
    ),
  );

  const attached = Object.fromEntries(
    Object.entries(refs).map(([name, ref]) => [name, ref.current instanceof HTMLElement]),
  );
  expect(attached).toEqual(Object.fromEntries(Object.keys(primitives).map((name) => [name, true])));
  expect(triggerRef.current?.textContent).toBe("Hover me");
  await React.act(async () => root.unmount());
  expect(reported).toEqual([]);
});

test("inert reaches the DOM, where React 18 drops a boolean", async () => {
  const { inertProps } = await import("../src/lib/inert");
  const app = document.createElement("div");
  document.body.append(app);
  const root = createRoot(app);
  const render = (hidden: boolean) =>
    React.act(async () =>
      root.render(React.createElement("section", { ...inertProps(hidden) }, "Panel")),
    );
  await render(true);
  expect(app.querySelector("section")!.hasAttribute("inert")).toBe(true);
  await render(false);
  expect(app.querySelector("section")!.hasAttribute("inert")).toBe(false);
  await React.act(async () => root.unmount());
  expect(reported).toEqual([]);
});
