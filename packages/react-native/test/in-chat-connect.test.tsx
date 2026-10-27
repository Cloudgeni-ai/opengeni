import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  act,
  createElement,
  forwardRef,
  useImperativeHandle,
  useRef,
  type ComponentType,
  type ReactNode,
} from "react";
import {
  ConnectController,
  ConnectPopupClosedError,
  type ConnectAttempt,
  type ConnectTransport,
} from "@opengeni/connect";
import type { AuthNeededItem, PendingApproval } from "@opengeni/react/session";
import { registerDom, renderComponent, type RenderedComponent } from "../../react/test/render-hook";

/*
 * Bun cannot parse react-native's Flow sources, so the host components are
 * stood in for by DOM elements. The cards and the shared connect model under
 * test are the real ones.
 */
function hostElement(tag: string) {
  return function Host(props: {
    children?: ReactNode;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    testID?: string;
  }) {
    return createElement(
      tag,
      {
        "aria-label": props.accessibilityLabel,
        "data-role": props.accessibilityRole,
        "data-testid": props.testID,
      },
      props.children,
    );
  };
}

mock.module("react-native", () => {
  const TextInput = forwardRef(function TextInput(props: Record<string, unknown>, ref) {
    const node = useRef<HTMLInputElement>(null);
    useImperativeHandle(ref, () => ({
      clear: () => {
        if (node.current) node.current.value = "";
      },
      measureInWindow: () => undefined,
    }));
    return createElement("input", {
      ref: node,
      "aria-label": props.accessibilityLabel,
      placeholder: props.placeholder,
      disabled: props.editable === false,
      onChange: (event: { target: { value: string } }) =>
        (props.onChangeText as ((value: string) => void) | undefined)?.(event.target.value),
    });
  });
  function Pressable(props: {
    children?: ReactNode | ((state: { pressed: boolean }) => ReactNode);
    onPress?: () => void;
    disabled?: boolean;
    accessibilityLabel?: string;
    accessibilityRole?: string;
  }) {
    return createElement(
      "button",
      {
        type: "button",
        disabled: props.disabled,
        onClick: () => props.onPress?.(),
        "aria-label": props.accessibilityLabel,
        "data-role": props.accessibilityRole,
      },
      typeof props.children === "function" ? props.children({ pressed: false }) : props.children,
    );
  }
  return {
    View: hostElement("div"),
    Text: hostElement("span"),
    ScrollView: hostElement("div"),
    ActivityIndicator: () => null,
    Pressable,
    TextInput,
    Platform: { OS: "ios", select: (options: Record<string, unknown>) => options.ios },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    // Bun keeps one "react-native" module per test process: expose every
    // export a later test file's component graph links against.
    Modal: hostElement("div"),
    KeyboardAvoidingView: hostElement("div"),
    Animated: {
      View: hostElement("div"),
      Value: function AnimatedValue() {},
      timing: () => ({ start: () => {} }),
    },
    Easing: { out: () => (value: number) => value, cubic: (value: number) => value },
    PanResponder: { create: () => ({ panHandlers: {} }) },
    ActionSheetIOS: { showActionSheetWithOptions: () => {} },
    Alert: { alert: () => {} },
    AppState: { addEventListener: () => ({ remove: () => {} }), currentState: "active" },
    FlatList: hostElement("div"),
    Image: hostElement("img"),
    Linking: { openURL: async () => {} },
    Share: { share: async () => ({}) },
    AccessibilityInfo: { isReduceMotionEnabled: async () => false },
    useWindowDimensions: () => ({ width: 390, height: 844 }),
  };
});
mock.module("react-native-svg", () => {
  const nothing = () => null;
  return {
    default: nothing,
    Circle: nothing,
    Defs: nothing,
    Line: nothing,
    LinearGradient: nothing,
    Path: nothing,
    Polyline: nothing,
    Rect: nothing,
    Stop: nothing,
  };
});
const layoutAnimation = { duration: () => layoutAnimation, delay: () => layoutAnimation };
mock.module("react-native-reanimated", () => ({
  default: { View: hostElement("div"), Text: hostElement("span"), ScrollView: hostElement("div") },
  cancelAnimation: () => undefined,
  Easing: { linear: (value: number) => value, inOut: () => (value: number) => value },
  FadeIn: layoutAnimation,
  FadeInDown: layoutAnimation,
  FadeOut: layoutAnimation,
  FadeOutDown: layoutAnimation,
  FadeOutUp: layoutAnimation,
  LinearTransition: layoutAnimation,
  interpolateColor: () => "#000",
  useAnimatedKeyboard: () => ({ height: { value: 0 } }),
  useAnimatedStyle: () => ({}),
  useReducedMotion: () => true,
  useSharedValue: (value: unknown) => ({ value }),
  withRepeat: (value: unknown) => value,
  withTiming: (value: unknown) => value,
}));

registerDom();

const {
  NativeAuthNeededRow,
  NativeConnectSetup,
  NativeIntegrationCapabilityCard,
  NativeMcpCapabilityCard,
  nativeConnectWindowHost,
  useNativeInChatConnect,
} =
  (await import("../src/timeline/in-chat-connect")) as typeof import("../src/timeline/in-chat-connect");
const { ApprovalStrip } = (await import("../src/timeline/decisions")) as {
  ApprovalStrip: ComponentType<{
    approvals: PendingApproval[];
    onDecide: (id: string, decision: "approve" | "reject") => Promise<void>;
  }>;
};

let mounted: RenderedComponent | null = null;
afterEach(async () => {
  const current = mounted;
  mounted = null;
  await current?.unmount();
});

function authItem(overrides: Partial<AuthNeededItem> = {}): AuthNeededItem {
  return {
    kind: "auth-needed",
    id: "auth-1",
    turnId: "turn-1",
    serverId: null,
    providerDomain: "linear.app",
    connectionId: null,
    reason: "expired",
    scopes: [],
    resource: null,
    toolName: null,
    authorizationUrl: null,
    occurredAt: "2026-10-25T12:00:00.000Z",
    ...overrides,
  };
}

const buttonLabels = () =>
  [...mounted!.container.querySelectorAll("button")].map(
    (button) => button.getAttribute("aria-label") ?? button.textContent?.trim(),
  );

describe("native connection row", () => {
  test("a first-time connection says connect, never reconnect", async () => {
    mounted = await renderComponent(
      <NativeAuthNeededRow item={authItem({ reason: "missing_connection" })} />,
    );
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("Connect Linear");
    expect(text).not.toMatch(/reconnect/i);
  });

  test("a lapsed connection with a link offers to reconnect", async () => {
    const opened: string[] = [];
    mounted = await renderComponent(
      <NativeAuthNeededRow
        item={authItem({ connectionId: "conn-1", authorizationUrl: "https://linear.app/auth" })}
        openUrl={(url) => opened.push(url)}
      />,
    );
    expect(mounted.container.textContent).toContain("Reconnect Linear");
    await act(async () => {
      [...mounted!.container.querySelectorAll("button")]
        .find((button) => button.textContent?.includes("Reconnect"))!
        .click();
    });
    expect(opened).toEqual(["https://linear.app/auth"]);
  });
});

describe("native sign-in window host", () => {
  test("opens the system sign-in browser and reports it closed once it returns", async () => {
    let finish: () => void = () => undefined;
    const opened: string[] = [];
    let dismissed = 0;
    const host = nativeConnectWindowHost({
      openAuthSession: (url) => {
        opened.push(url);
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
      dismiss: () => {
        dismissed += 1;
      },
    });
    const reserved = host.reserve();
    const popup = reserved.navigation.openPopup("https://provider.example/authorize");
    await Promise.resolve();
    await Promise.resolve();
    expect(opened).toEqual(["https://provider.example/authorize"]);
    expect(popup?.closed).toBe(false);
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(popup?.closed).toBe(true);
    // Already back in the app: nothing left to dismiss.
    reserved.close();
    expect(dismissed).toBe(0);
  });

  test("closing an open sign-in dismisses the browser, and plain HTTP is refused", () => {
    let dismissed = 0;
    const host = nativeConnectWindowHost({
      openAuthSession: () => new Promise(() => undefined),
      dismiss: () => {
        dismissed += 1;
      },
    });
    const reserved = host.reserve();
    reserved.navigation.openPopup("https://provider.example/authorize");
    reserved.close();
    expect(dismissed).toBe(1);
    expect(() => host.open().redirect("http://provider.example/authorize")).toThrow();
  });
});

describe("native approval card", () => {
  test("an app action reads as one plain question with Allow and Cancel", async () => {
    const decided: string[] = [];
    const args = {
      id: "createOrganizationInvitation",
      pathParameters: { organizationId: "org-1" },
      body: { email: "anna@example.com", role: "member" },
    };
    mounted = await renderComponent(
      <ApprovalStrip
        approvals={[
          {
            id: "call-invite",
            name: "opengeni__admin_action_call",
            arguments: args,
            display: {
              toolName: "admin_action_call",
              title: "Invite anna@example.com to your organization?",
            },
          } as PendingApproval,
        ]}
        onDecide={async (id, decision) => {
          decided.push(`${id}:${decision}`);
        }}
      />,
    );
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("Invite anna@example.com to your organization?");
    expect(text).toContain("anna@example.com");
    // The raw call waits behind Details.
    expect(text).not.toContain("createOrganizationInvitation");
    const labels = buttonLabels();
    expect(labels).toContain("Allow");
    expect(labels).toContain("Cancel");
    expect(labels).toContain("Details");
    await act(async () => {
      [...mounted!.container.querySelectorAll("button")]
        .find((button) => button.textContent?.trim() === "Allow")!
        .click();
    });
    expect(decided).toEqual(["call-invite:approve"]);
  });
});

/* ------------------------------------------------------- connect flows -- */

function attempt(overrides: Partial<ConnectAttempt> = {}): ConnectAttempt {
  return {
    id: "attempt-1",
    workspaceId: "workspace",
    providerId: "example-keys",
    ownership: "personal",
    revision: 1,
    state: "credential_input",
    credentialsCommitted: false,
    integrationInstalled: false,
    completionRequirement: "connection",
    nextAction: {
      type: "credentials",
      fields: [{ name: "apiKey", label: "API key", secret: true, required: true }],
    },
    expiresAt: "2030-01-01T00:00:00Z",
    ...overrides,
  } as ConnectAttempt;
}

/** A transport that answers from a script and records what it was sent. */
function fakeTransport(script: {
  begin?: () => ConnectAttempt;
  get?: (id: string) => ConnectAttempt;
  cancel?: (id: string) => ConnectAttempt;
}) {
  const advanced: unknown[] = [];
  const transport = {
    catalog: async () => [],
    accounts: async () => [],
    pending: async () => [],
    begin: async () => script.begin!(),
    get: async (_workspace: string, id: string) => script.get!(id),
    advance: async (_workspace: string, id: string, input: unknown) => {
      advanced.push(input);
      return attempt({ id, revision: 9, state: "provider_wait", nextAction: { type: "none" } });
    },
    cancel: async (_workspace: string, id: string) => script.cancel!(id),
    disconnect: async () => undefined,
  } as unknown as ConnectTransport;
  return { transport, advanced };
}

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

function typeInto(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  const props = Object.keys(input).find((key) => key.startsWith("__reactProps$"))!;
  (input as unknown as Record<string, { onChange: (event: unknown) => void }>)[props]!.onChange({
    target: input,
  });
}

function buttonNamed(label: string): HTMLButtonElement | undefined {
  return [...mounted!.container.querySelectorAll("button")].find(
    (entry) => (entry.getAttribute("aria-label") ?? entry.textContent?.trim()) === label,
  );
}

describe("native connect setup", () => {
  test("a key typed for a cancelled setup never reaches the next one", async () => {
    let next = 0;
    const { transport, advanced } = fakeTransport({
      begin: () => attempt({ id: `attempt-${++next}` }),
      cancel: (id) =>
        attempt({ id, revision: 2, state: "cancelled", nextAction: { type: "none" } }),
    });
    const controller = new ConnectController(transport, "workspace");
    await controller.begin({
      providerId: "example-keys",
      ownership: "personal",
      returnUrl: "https://console.example/return",
      idempotencyKey: "one",
    });
    mounted = await renderComponent(
      <NativeConnectSetup controller={controller} onAuthorize={() => undefined} />,
    );
    const field = () => mounted!.container.querySelector("input") as HTMLInputElement;
    // The field's placeholder names the key it wants.
    expect(field().getAttribute("placeholder")).toBe("API key");
    await act(async () => typeInto(field(), "old-secret"));
    expect(buttonNamed("Continue")?.disabled).toBe(false);
    await act(async () => {
      await controller.cancel(crypto.randomUUID());
    });
    await act(async () => {
      await controller.begin({
        providerId: "example-keys",
        ownership: "personal",
        returnUrl: "https://console.example/return",
        idempotencyKey: "two",
      });
    });
    await flush();
    expect(field().value).toBe("");
    expect(buttonNamed("Continue")?.disabled).toBe(true);
    await act(async () => buttonNamed("Continue")?.click());
    expect(advanced).toEqual([]);
    await act(async () => typeInto(field(), "new-secret"));
    await act(async () => buttonNamed("Continue")!.click());
    await flush();
    expect(advanced).toHaveLength(1);
    expect(JSON.stringify(advanced[0])).toContain('"apiKey":"new-secret"');
    expect(JSON.stringify(advanced[0])).not.toContain("old-secret");
  });

  test("closing the sign-in browser says so and offers to sign in again", async () => {
    const authorize = attempt({
      state: "requires_user_action",
      nextAction: { type: "authorize", url: "https://provider.example/authorize" },
    } as Partial<ConnectAttempt>);
    const { transport } = fakeTransport({ begin: () => authorize });
    const controller = new ConnectController(transport, "workspace");
    await controller.begin({
      providerId: "example-oauth",
      ownership: "personal",
      returnUrl: "https://console.example/return",
      idempotencyKey: "one",
    });
    mounted = await renderComponent(
      <NativeConnectSetup
        controller={controller}
        authorizeLabel="Sign in"
        onAuthorize={() => Promise.reject(new ConnectPopupClosedError())}
      />,
    );
    await act(async () => buttonNamed("Sign in")!.click());
    await flush();
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("Sign-in window closed. You can try connecting again.");
    expect(text).not.toContain("could not continue");
    expect(buttonNamed("Try signing in again")).toBeDefined();
  });
});

function connectRequest(): AuthNeededItem {
  return authItem({
    source: "capability",
    reason: "missing_connection",
    providerDomain: "calendar.example.com",
    capability: {
      id: "api:integration:example-calendar",
      name: "Example Calendar",
      kind: "api",
      source: "library",
      action: "connect",
      rationale: "To read your calendar.",
      requiredVariables: [],
    },
  } as Partial<AuthNeededItem>);
}

function ConnectHarness({ client, item }: { client: unknown; item: AuthNeededItem }) {
  const render = useNativeInChatConnect({
    client: client as never,
    workspaceId: "workspace",
    sessionId: "session",
    items: [item],
    options: {
      browser: { openAuthSession: async () => undefined },
      returnUrl: "https://console.example/return",
    },
  });
  return <>{render?.(item)}</>;
}

describe("native in-chat connect requests", () => {
  test("a failed read of the person's access offers a retry, not a dead end", async () => {
    let reads = 0;
    const client = {
      getClientConfig: async () => ({ chatConnections: true }),
      getAccessContext: async () => {
        reads += 1;
        throw new Error("network down");
      },
      listCapabilities: async () => ({ items: [] }),
    };
    mounted = await renderComponent(<ConnectHarness client={client} item={connectRequest()} />);
    await flush();
    await flush();
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("Couldn't load this connection. Try again.");
    expect(text).not.toMatch(/management access|reconnect/i);
    expect(reads).toBe(1);
    await act(async () => buttonNamed("Retry")!.click());
    await flush();
    expect(reads).toBe(2);
  });

  test("a session proxy that owns chat setup keeps the plain row", async () => {
    const client = {
      getClientConfig: async () => ({ chatConnections: false }),
      getAccessContext: async () => {
        throw new Error("must not be read");
      },
      listCapabilities: async () => ({ items: [] }),
    };
    mounted = await renderComponent(<ConnectHarness client={client} item={connectRequest()} />);
    await flush();
    await flush();
    expect(mounted.container.textContent).toContain("Example Calendar");
    expect(mounted.container.textContent).not.toContain("Couldn't load this connection");
    expect(buttonNamed("Retry")).toBeUndefined();
  });

  test("a sign-in finished while the app was closed still lets the agent continue", async () => {
    const stored = new Map([
      [
        "opengeni:session-integration-connect:workspace:session:api:integration:example-calendar",
        "attempt-done",
      ],
    ]);
    const continued: unknown[] = [];
    const complete = attempt({
      id: "attempt-done",
      revision: 5,
      state: "complete",
      credentialsCommitted: true,
      integrationInstalled: true,
      completionRequirement: "integration",
      nextAction: { type: "none" },
    });
    const { transport } = fakeTransport({ get: () => complete });
    const client = {
      connectTransport: () => transport,
      listApiIntegrations: async () => ({ integrations: [] }),
      continueAfterCapabilitySetup: async (...args: unknown[]) => {
        continued.push(args);
        return { outcome: "continued" };
      },
    };
    mounted = await renderComponent(
      <NativeIntegrationCapabilityCard
        client={client as never}
        workspaceId="workspace"
        sessionId="session"
        capabilityId="api:integration:example-calendar"
        name="Example Calendar"
        rationale="To read your calendar."
        options={{
          browser: { openAuthSession: async () => undefined },
          returnUrl: "https://console.example/return",
          attemptHints: {
            read: (key) => stored.get(key) ?? null,
            remember: (key, id) => void stored.set(key, id),
            forget: (key) => void stored.delete(key),
          },
        }}
      />,
    );
    for (let pass = 0; pass < 4; pass += 1) await flush();
    expect(continued).toEqual([
      ["workspace", "session", { capabilityId: "api:integration:example-calendar" }],
    ]);
    expect(stored.size).toBe(0);
    expect(mounted.container.textContent).toContain("Your account is connected");
  });
});

describe("native saved sign-in attempts", () => {
  test("a cancelled or failed attempt is forgotten, so the next setup starts fresh", async () => {
    for (const state of ["cancelled", "failed"] as const) {
      const key =
        "opengeni:session-integration-connect:workspace:session:api:integration:example-calendar";
      const stored = new Map([[key, "attempt-old"]]);
      const settled = attempt({
        id: "attempt-old",
        revision: 4,
        state,
        completionRequirement: "integration",
        nextAction: { type: "none" },
      });
      const { transport } = fakeTransport({ get: () => settled });
      const client = {
        connectTransport: () => transport,
        listApiIntegrations: async () => ({ integrations: [] }),
      };
      mounted = await renderComponent(
        <NativeIntegrationCapabilityCard
          client={client as never}
          workspaceId="workspace"
          sessionId="session"
          capabilityId="api:integration:example-calendar"
          name="Example Calendar"
          rationale="To read your calendar."
          options={{
            browser: { openAuthSession: async () => undefined },
            returnUrl: "https://console.example/return",
            attemptHints: {
              read: (entry) => stored.get(entry) ?? null,
              remember: (entry, id) => void stored.set(entry, id),
              forget: (entry) => void stored.delete(entry),
            },
          }}
        />,
      );
      for (let pass = 0; pass < 4; pass += 1) await flush();
      expect({ state, saved: stored.size }).toEqual({ state, saved: 0 });
      await mounted.unmount();
      mounted = null;
    }
  });
});

describe("native MCP saved sign-in attempts", () => {
  test("a cancelled or expired attempt is forgotten once the card picks it up", async () => {
    for (const state of ["cancelled", "expired"] as const) {
      const key = "opengeni:session-connect:workspace:session:mcp:example-calendar";
      const stored = new Map([[key, "attempt-old"]]);
      const settled = attempt({
        id: "attempt-old",
        providerId: "example-calendar",
        revision: 4,
        state,
        nextAction: { type: "none" },
      });
      const item = {
        id: "mcp:example-calendar",
        kind: "mcp",
        source: "library",
        stale: false,
        authKind: "oauth2",
        metadata: {},
        name: "Example Calendar",
        description: "Read and plan your calendar.",
        providerDomain: "calendar.example.com",
        mcpUrl: "https://calendar.example.com/mcp",
        enabled: false,
        connectionRef: null,
      };
      const client = new Proxy(
        {
          listCapabilities: async () => ({ items: [item] }),
          listConnections: async () => [],
          connectTransport: () => fakeTransport({ get: () => settled }).transport,
          getSession: async () => ({ toolPolicy: { mode: "custom" }, tools: [] }),
        },
        { get: (target, name) => (name in target ? Reflect.get(target, name) : async () => ({})) },
      );
      mounted = await renderComponent(
        <NativeMcpCapabilityCard
          client={client as never}
          workspaceId="workspace"
          sessionId="session"
          capabilityId="mcp:example-calendar"
          name="Example Calendar"
          rationale="To read your calendar."
          personalOnly={false}
          options={{
            browser: { openAuthSession: async () => undefined },
            returnUrl: "https://console.example/return",
            attemptHints: {
              read: (entry) => stored.get(entry) ?? null,
              remember: (entry, id) => void stored.set(entry, id),
              forget: (entry) => void stored.delete(entry),
            },
          }}
        />,
      );
      for (let pass = 0; pass < 3; pass += 1) await flush();
      expect(stored.size).toBe(1);
      await act(async () => buttonNamed("Connect Example Calendar")!.click());
      for (let pass = 0; pass < 4; pass += 1) await flush();
      expect({ state, saved: stored.size }).toEqual({ state, saved: 0 });
      await mounted.unmount();
      mounted = null;
    }
  });
});

describe("native approval without recorded arguments", () => {
  test("keeps Approve, as before", async () => {
    const decided: string[] = [];
    mounted = await renderComponent(
      <ApprovalStrip
        approvals={[{ id: "call-old", name: "example_tool" } as PendingApproval]}
        onDecide={async (id, decision) => {
          decided.push(`${id}:${decision}`);
        }}
      />,
    );
    expect(mounted.container.textContent).not.toContain("can't be approved");
    const approve = [...mounted.container.querySelectorAll("button")].find(
      (entry) => entry.textContent?.trim() === "Approve",
    );
    expect(approve).toBeDefined();
    await act(async () => approve!.click());
    expect(decided).toEqual(["call-old:approve"]);
  });
});

describe("native MCP service card", () => {
  test("a reviewed catalog service shows its provider, not an MCP server label", async () => {
    const render = async (source: string) => {
      const item = {
        id: "mcp:example-calendar",
        kind: "mcp",
        source,
        stale: false,
        authKind: "oauth2",
        metadata: {},
        name: "Example Calendar",
        description: "Read and plan your calendar.",
        providerDomain: "calendar.example.com",
        mcpUrl: "https://calendar.example.com/mcp",
        enabled: false,
        connectionRef: null,
      };
      const client = new Proxy(
        {
          listCapabilities: async () => ({ items: [item] }),
          listConnections: async () => [],
          connectTransport: () => fakeTransport({}).transport,
        },
        { get: (target, key) => (key in target ? Reflect.get(target, key) : async () => ({})) },
      );
      const view = await renderComponent(
        <NativeMcpCapabilityCard
          client={client as never}
          workspaceId="workspace"
          sessionId="session"
          capabilityId="mcp:example-calendar"
          name="Example Calendar"
          rationale="To read your calendar."
          personalOnly={false}
          options={{
            browser: { openAuthSession: async () => undefined },
            returnUrl: "https://console.example/return",
          }}
        />,
      );
      for (let pass = 0; pass < 3; pass += 1) await flush();
      const text = view.container.textContent ?? "";
      await view.unmount();
      return {
        label: text.includes("MCP server"),
        provider: text.includes("calendar.example.com"),
      };
    };
    expect(await render("library")).toEqual({ label: false, provider: true });
    expect(await render("manual")).toEqual({ label: true, provider: true });
  });
});
