import { useOpenGeniText } from "@opengeni/react/messages";
import {
  authNeededPresentation,
  canFinishPreparedMcpSetup,
  inChatConnectDecision,
  isInChatConnectRequest,
  isPreparedMcpSetup,
  useConnectSetupFlow,
  useInChatConnectSupport,
  useIntegrationCapabilityConnect,
  useMcpCapabilityConnect,
  usePreparedMcpSetupAccess,
  usePreparedMcpSetupAttempt,
  type ConnectAttempt,
  type ConnectController,
  type ConnectNavigation,
  type ConnectWindowHost,
  type InChatConnectSource,
} from "@opengeni/react/in-chat-connect-model";
import type { AuthNeededItem, TimelineItem } from "@opengeni/react/session";
import type { HumanInputSecretSpec, OpenGeniClient } from "@opengeni/sdk";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentRef,
  type ReactNode,
  type RefObject,
} from "react";
import { Linking, Pressable, Text, TextInput, View } from "react-native";
import { Button } from "./controls";
import { Icon, type NativeIconName } from "./icon";
import { withAlpha } from "./primitives";
import { SecureValueInput } from "./secret-field";
import { defaultSecretFieldMessages, secretInputTraits } from "./secret-field-model";
import { Selector } from "./selector";
import { fontStyle, useNativeTimelineTheme } from "./theme";

/* ----------------------------------------------------------------------------
   An agent's "connect your account" request, finished in the chat: the same
   cards and decisions as the web conversation (shared from
   @opengeni/react/in-chat-connect-model), drawn natively. Sign-in opens the
   system sign-in browser and returns to the app; keys go into the secure
   field and never enter React state. Each card follows the attempt's durable
   state, so the window closing is never taken as success, and once setup is
   done the agent continues the request that asked.
   -------------------------------------------------------------------------- */

/** The system sign-in browser the host app provides (for example expo-web-browser). */
export interface NativeConnectBrowser {
  /**
   * Open `url` in the system sign-in browser. Resolve once it closes or hands
   * back to the app; the result is not read.
   */
  openAuthSession(url: string): Promise<unknown>;
  /** Close a sign-in browser that is still open, where the platform allows it. */
  dismiss?(): void;
}

export interface NativeInChatConnectOptions {
  browser: NativeConnectBrowser;
  /**
   * The exact page the provider returns to after sign-in, usually one that
   * hands the person back to this app.
   */
  returnUrl: string;
  /** Open an ordinary link (an approval link to pass on, a verification page). */
  openUrl?: ((url: string) => void) | undefined;
}

function requireHttps(url: string): void {
  if (!/^https:\/\/[^/@]+(\/|$)/iu.test(url) || /^https:\/\/[^/]*@/iu.test(url))
    throw new Error("Connect authorization requires an HTTPS destination without credentials");
}

/**
 * The connect cards' sign-in windows on a phone: the system sign-in browser.
 * `closed` turns true once the browser returns, so the card rechecks the
 * attempt's durable state at once instead of waiting out its poll.
 */
export function nativeConnectWindowHost(browser: NativeConnectBrowser): ConnectWindowHost {
  const window = () => {
    let opened = false;
    let closed = false;
    const close = () => {
      if (!opened || closed) return;
      closed = true;
      try {
        browser.dismiss?.();
      } catch {
        /* The browser may already be gone. */
      }
    };
    const open = (url: string) => {
      requireHttps(url);
      opened = true;
      void Promise.resolve()
        .then(() => browser.openAuthSession(url))
        .catch(() => undefined)
        .finally(() => {
          closed = true;
        });
    };
    const navigation: ConnectNavigation = {
      openPopup(url) {
        open(url);
        return {
          close,
          get closed() {
            return closed;
          },
        };
      },
      redirect: open,
    };
    return { navigation, close };
  };
  return { reserve: window, open: () => window().navigation };
}

/**
 * The renderer for agents' connect requests in a native conversation: reads
 * the person's grant and the catalog only while such a request is on screen,
 * then draws the card the web conversation would.
 */
export function useNativeInChatConnect({
  client,
  workspaceId,
  sessionId,
  items,
  options,
}: {
  client: OpenGeniClient | undefined;
  workspaceId: string;
  sessionId: string;
  items: readonly TimelineItem[];
  options: NativeInChatConnectOptions | undefined;
}): ((item: AuthNeededItem) => ReactNode) | undefined {
  const needed = useMemo(
    () => items.some((item) => item.kind === "auth-needed" && isInChatConnectRequest(item)),
    [items],
  );
  const enabled = Boolean(client && options);
  const source = (client ?? {}) as Partial<InChatConnectSource>;
  const support = useInChatConnectSupport(source, workspaceId, needed && enabled);
  const latest = useRef(options);
  latest.current = options;
  return useCallback(
    (item: AuthNeededItem) => {
      const host = latest.current;
      if (!client || !host) return <NativeAuthNeededRow item={item} />;
      const key = `${workspaceId}:${sessionId}:${item.id}`;
      if (isPreparedMcpSetup(item)) {
        if (support.status === "idle" || support.status === "loading")
          return <NativeAuthNeededRow item={item} />;
        return (
          <NativePreparedMcpSetupCard
            key={`${key}:${JSON.stringify(item.setupRequest)}`}
            client={client}
            workspaceId={workspaceId}
            sessionId={sessionId}
            item={item}
            canConfigure={canFinishPreparedMcpSetup(support)}
            options={host}
          />
        );
      }
      // A native conversation always lets people connect in the chat; the
      // grant and catalog decide which card, exactly as on the web.
      const decision = inChatConnectDecision(item, support, true);
      if (decision.kind === "unavailable")
        return <NativeAuthNeededRow item={item} setupUnavailable />;
      if (decision.kind === "integration")
        return (
          <NativeIntegrationCapabilityCard
            key={`${key}:${decision.capabilityId}`}
            client={client}
            workspaceId={workspaceId}
            sessionId={sessionId}
            capabilityId={decision.capabilityId}
            name={decision.name}
            rationale={item.capability?.rationale ?? ""}
            options={host}
          />
        );
      if (decision.kind === "card")
        return (
          <NativeMcpCapabilityCard
            key={`${key}:${decision.item.id}`}
            client={client}
            workspaceId={workspaceId}
            sessionId={sessionId}
            capabilityId={decision.item.id}
            name={decision.item.name}
            personalOnly={decision.personalOnly}
            rationale={item.capability?.rationale ?? ""}
            options={host}
          />
        );
      return <NativeAuthNeededRow item={item} />;
    },
    [client, workspaceId, sessionId, support],
  );
}

/* ------------------------------------------------------------------ frame -- */

function useText() {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  return {
    theme,
    c,
    body: { ...fontStyle(theme), fontSize: theme.size.sm, lineHeight: 20, color: c.fg },
    muted: {
      ...fontStyle(theme),
      fontSize: theme.size.sm,
      lineHeight: 20,
      color: c["fg-muted"],
    },
    small: { ...fontStyle(theme), fontSize: theme.size.xs, lineHeight: 16, color: c["fg-subtle"] },
    label: { ...fontStyle(theme, 500), fontSize: theme.size.sm, lineHeight: 18, color: c.fg },
  };
}

function monogram(label: string): string {
  const words = label.trim().split(/\s+/u).filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

function Mark({ name }: { name: string }) {
  const { theme, c } = useText();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: 40,
        height: 40,
        borderRadius: theme.radius.md,
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: c["surface-2"],
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ ...fontStyle(theme, 600), fontSize: 13, color: c["fg-muted"] }}>
        {monogram(name)}
      </Text>
    </View>
  );
}

function Line({
  children,
  tone = "muted",
  icon,
  role,
}: {
  children: ReactNode;
  tone?: "body" | "muted" | "small" | "error" | "waiting";
  icon?: NativeIconName | undefined;
  role?: "alert" | undefined;
}) {
  const text = useText();
  const color =
    tone === "error"
      ? text.c["status-failed"]
      : tone === "waiting"
        ? text.c["status-waiting"]
        : undefined;
  const base = tone === "body" ? text.body : tone === "small" ? text.small : text.muted;
  const line = (
    <Text
      accessibilityRole={role}
      accessibilityLiveRegion={role ? "polite" : undefined}
      style={{ ...base, ...(color ? { color } : {}), flexShrink: 1 }}
    >
      {children}
    </Text>
  );
  if (!icon) return line;
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 6 }}>
      <View style={{ paddingTop: tone === "small" ? 1 : 3 }}>
        <Icon name={icon} size={13} color={color ?? text.c["fg-subtle"]} />
      </View>
      {line}
    </View>
  );
}

/** The web capability card at phone width: who it is, why, and one clear action. */
function CapabilityFrame({
  name,
  subtitle,
  typeLabel,
  description,
  complete,
  completeLabel,
  note,
  children,
}: {
  name: string;
  subtitle?: string | undefined;
  typeLabel: string;
  description?: string | undefined;
  complete: boolean;
  completeLabel?: string | undefined;
  note?: string | undefined;
  children?: ReactNode;
}) {
  const t = useOpenGeniText();
  const text = useText();
  const { theme, c } = text;
  return (
    <View style={{ gap: 6 }}>
      <View
        accessibilityLabel={t("sessionCapabilityFrame.nameSetup", { name })}
        style={{
          borderRadius: theme.radius.lg,
          borderWidth: 1,
          borderColor: c.border,
          backgroundColor: c["surface-1"],
          padding: 14,
          gap: 12,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Mark name={name} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text
              accessibilityRole="header"
              numberOfLines={2}
              style={{ ...fontStyle(theme, 600), fontSize: theme.size.md, color: c.fg }}
            >
              {name}
            </Text>
            {subtitle ? (
              <Text numberOfLines={1} style={text.small}>
                {subtitle}
              </Text>
            ) : null}
          </View>
          {complete ? (
            <Icon name="check" size={18} color={c.accent} />
          ) : (
            <View
              style={{
                borderRadius: theme.radius.full,
                borderWidth: 1,
                borderColor: c.border,
                paddingHorizontal: 8,
                paddingVertical: 2,
              }}
            >
              <Text style={{ ...text.small, color: c["fg-muted"] }}>{typeLabel}</Text>
            </View>
          )}
        </View>
        {complete ? (
          <Line tone="body" role="alert">
            {completeLabel ?? t("sessionCapabilityFrame.connectedAvailableInThisConversation")}
          </Line>
        ) : description ? (
          <Line tone="body">{description}</Line>
        ) : null}
        {children}
      </View>
      {!complete && note ? (
        <View style={{ paddingHorizontal: 4 }}>
          <Line tone="small">{note}</Line>
        </View>
      ) : null}
    </View>
  );
}

/** "You choose what to authorize" beside the card's one primary action. */
function PrimaryAction({
  label,
  onPress,
  busy,
  disabled,
}: {
  label: string;
  onPress: () => void;
  busy?: boolean | undefined;
  disabled?: boolean | undefined;
}) {
  const t = useOpenGeniText();
  return (
    <View style={{ gap: 10 }}>
      <Line tone="small" icon="shield-check">
        {t("sessionCapabilityFrame.youChooseWhatToAuthorize")}
      </Line>
      <Button
        icon="plug"
        variant="primary"
        size="form"
        label={label}
        busy={busy}
        disabled={disabled}
        onPress={onPress}
        style={{ alignSelf: "stretch" }}
      />
    </View>
  );
}

function openLink(options: NativeInChatConnectOptions | undefined, url: string) {
  if (options?.openUrl) options.openUrl(url);
  else void Linking.openURL(url);
}

/* ------------------------------------------------------- connect setup -- */

function Choice({
  label,
  detail,
  multi,
  selected,
  disabled,
  onPress,
}: {
  label: string;
  detail?: string | undefined;
  multi: boolean;
  selected: boolean;
  disabled?: boolean | undefined;
  onPress: () => void;
}) {
  const text = useText();
  return (
    <Pressable
      accessibilityRole={multi ? "checkbox" : "radio"}
      accessibilityLabel={label}
      accessibilityState={{ checked: selected, disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        minHeight: 44,
        opacity: disabled ? 0.5 : pressed ? 0.7 : 1,
      })}
    >
      <Selector multi={multi} selected={selected} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={text.label}>{label}</Text>
        {detail ? <Text style={text.small}>{detail}</Text> : null}
      </View>
    </Pressable>
  );
}

/** A key is no website password: no autofill, no saving prompt. */
const KEY_TRAITS = secretInputTraits({ itemType: "api_key" } as HumanInputSecretSpec);

type CredentialField = Extract<
  ConnectAttempt["nextAction"],
  { type: "credentials" }
>["fields"][number];

/** One credential: a choice list, a plain text field, or the secure field. */
function CredentialInput({
  field,
  disabled,
  onValue,
  register,
}: {
  field: CredentialField;
  disabled: boolean;
  onValue: (value: string) => void;
  register: (clear: (() => void) | null) => void;
}) {
  const t = useOpenGeniText();
  const text = useText();
  const { theme, c } = text;
  const secretText = defaultSecretFieldMessages(t);
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const [revealed, setRevealed] = useState(false);
  const [option, setOption] = useState("");
  const registerClear = useRef(register);
  registerClear.current = register;
  useEffect(() => {
    registerClear.current(() => {
      input.current?.clear();
      setRevealed(false);
      setOption("");
    });
    return () => registerClear.current(null);
  }, []);
  if (field.options) {
    const choices = field.required
      ? field.options
      : [{ value: "", label: t("connectSetup.noAccountPublicService") }, ...field.options];
    return (
      <View style={{ gap: 2 }}>
        <Text style={text.label}>{field.label}</Text>
        <View accessibilityRole="radiogroup" accessibilityLabel={field.label}>
          {choices.map((choice) => (
            <Choice
              key={choice.value || "none"}
              label={choice.label}
              multi={false}
              selected={option === choice.value}
              disabled={disabled}
              onPress={() => {
                setOption(choice.value);
                onValue(choice.value);
              }}
            />
          ))}
        </View>
      </View>
    );
  }
  return (
    <View style={{ gap: 6 }}>
      <Text style={text.label}>{field.label}</Text>
      {field.secret ? (
        <SecureValueInput
          inputRef={input}
          testID={`connect-secret-${field.name}`}
          accessibilityLabel={field.label}
          editable={!disabled}
          traits={KEY_TRAITS}
          placeholder={secretText.placeholder.off}
          onChangeText={onValue}
          revealed={revealed}
          onRevealedChange={setRevealed}
          showLabel={secretText.show}
          hideLabel={secretText.hide}
        />
      ) : (
        <PlainInput
          inputRef={input}
          label={field.label}
          disabled={disabled}
          onValue={onValue}
          style={{
            ...fontStyle(theme),
            fontSize: theme.size.sm,
            color: c.fg,
            minHeight: 44,
            borderRadius: theme.radius.sm,
            borderWidth: 1,
            borderColor: c.border,
            backgroundColor: c["surface-1"],
            paddingHorizontal: 10,
          }}
        />
      )}
    </View>
  );
}

function PlainInput({
  inputRef,
  label,
  disabled,
  onValue,
  style,
}: {
  inputRef: RefObject<ComponentRef<typeof TextInput> | null>;
  label: string;
  disabled: boolean;
  onValue: (value: string) => void;
  style: object;
}) {
  const { c } = useText();
  return (
    <TextInput
      ref={inputRef}
      accessibilityLabel={label}
      editable={!disabled}
      autoCorrect={false}
      autoCapitalize="none"
      autoComplete="off"
      importantForAutofill="no"
      onChangeText={onValue}
      placeholderTextColor={c["fg-subtle"]}
      style={style}
    />
  );
}

/** The step after the first tap: the same steps as the web setup view. */
export function NativeConnectSetup({
  controller,
  authorizeLabel,
  onAuthorize,
  options,
}: {
  controller: ConnectController;
  authorizeLabel?: string | undefined;
  onAuthorize: (attempt: ConnectAttempt) => void | Promise<unknown>;
  options?: NativeInChatConnectOptions | undefined;
}) {
  const t = useOpenGeniText();
  const text = useText();
  const flow = useConnectSetupFlow(controller, { onAuthorize });
  const { view, attempt } = flow;
  // Typed values live in this ref until submit, never in React state.
  const values = useRef(new Map<string, string>());
  const clears = useRef(new Map<string, () => void>());
  const [filled, setFilled] = useState<ReadonlySet<string>>(new Set());
  const [choice, setChoice] = useState<string | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const step = attempt ? `${attempt.id}:${attempt.revision}` : "";
  const [shownStep, setShownStep] = useState(step);
  if (shownStep !== step) {
    setShownStep(step);
    setChoice(null);
    setPicked(new Set());
  }
  if (!attempt) return <Line role="alert">{flow.status}</Line>;
  const action = attempt.nextAction;
  const disabled = flow.busy;
  const toggle = (id: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const missingRequired =
    action.type === "credentials" &&
    action.fields.some((field) => field.required && !filled.has(field.name));
  const submit = () => {
    if (flow.busy) return;
    if (action.type === "credentials") {
      if (missingRequired) return;
      const submitted = Object.fromEntries(
        action.fields.map((field) => [field.name, values.current.get(field.name) ?? ""]),
      );
      // Empty the fields before the remote work; nothing here keeps the values.
      values.current.clear();
      for (const clear of clears.current.values()) clear();
      setFilled(new Set());
      flow.submitCredentials(submitted);
    } else if (action.type === "select_account") {
      if (choice) flow.selectAccount(choice);
    } else if (action.type === "select_resources") {
      flow.selectResources([...picked]);
    } else if (action.type === "preview") {
      flow.install([...picked]);
    }
  };
  return (
    <View
      accessibilityLabel={t("connectSetup.connectionSetup")}
      accessibilityState={{ busy: flow.busy }}
      style={{ gap: 12 }}
    >
      <View style={{ gap: 2 }}>
        <Text style={{ ...text.small, color: text.c["fg-muted"] }}>{flow.scopeLabel}</Text>
        <Line tone="body" role="alert">
          {flow.status}
        </Line>
        <Line tone="small">{flow.scopeDescription}</Line>
      </View>
      {attempt.account ? (
        <Line>{t("connectSetup.accountLabel", { label: attempt.account.label })}</Line>
      ) : null}
      {flow.awaitingOwner ? (
        <View style={{ gap: 4 }}>
          <Line tone="body">{t("connectSetup.yourRequestWasSentGithub")}</Line>
          <Line>1. {t("connectSetup.anOrganizationOwnerApprovesThe")}</Line>
          <Line>2. {t("connectSetup.anOwnerThenConnectsThe")}</Line>
          <Line tone="small">{t("connectSetup.nothingIsConnectedUntilThen")}</Line>
        </View>
      ) : null}
      {flow.adminApproval ? (
        <View style={{ gap: 4 }}>
          <Line tone="waiting" role="alert" icon="circle-alert">
            {flow.adminApproval.required
              ? t("connectSetup.microsoftAdminApprovalRequired")
              : t("connectSetup.microsoftAdminApprovalMaybe")}
          </Line>
          <Line>1. {t("connectSetup.sendTheApprovalLinkTo")}</Line>
          <Line>2. {t("connectSetup.afterTheyApproveConnectAgain")}</Line>
          <Button
            icon="external-link"
            label={t("connectSetup.adminApprovalLink")}
            onPress={() => openLink(options, flow.adminApproval!.url)}
            style={{ alignSelf: "flex-start" }}
          />
        </View>
      ) : null}
      {flow.errorText ? (
        <Line tone="error" role="alert" icon="circle-alert">
          {flow.errorText}
        </Line>
      ) : null}
      {flow.interactive ? (
        <View key={step} style={{ gap: 12 }}>
          {attempt.state === "connected_but_incomplete" &&
          action.type === "none" &&
          !flow.awaitingOwner ? (
            <Button
              variant="primary"
              size="form"
              label={t("connectSetup.chooseTools")}
              disabled={disabled}
              onPress={flow.chooseTools}
            />
          ) : null}
          {action.type === "credentials"
            ? action.fields.map((field) => (
                <CredentialInput
                  key={field.name}
                  field={field}
                  disabled={disabled}
                  register={(clear) => {
                    if (clear) clears.current.set(field.name, clear);
                    else clears.current.delete(field.name);
                  }}
                  onValue={(value) => {
                    values.current.set(field.name, value);
                    const has = value.length > 0;
                    setFilled((current) => {
                      if (current.has(field.name) === has) return current;
                      const next = new Set(current);
                      if (has) next.add(field.name);
                      else next.delete(field.name);
                      return next;
                    });
                  }}
                />
              ))
            : null}
          {action.type === "select_account" ? (
            <View accessibilityRole="radiogroup" accessibilityLabel={t("connectSetup.account")}>
              <Text style={text.label}>{t("connectSetup.chooseAnAccount")}</Text>
              {action.accounts.map((account) => (
                <Choice
                  key={account.id}
                  label={account.label}
                  detail={account.ownership}
                  multi={false}
                  selected={choice === account.id}
                  disabled={disabled || account.status === "disabled"}
                  onPress={() => setChoice(account.id)}
                />
              ))}
              {flow.offersGitHubRequest ? (
                <Line tone="small">{t("connectSetup.donTSeeYourOrganization")}</Line>
              ) : null}
            </View>
          ) : null}
          {action.type === "select_resources" ? (
            <View>
              {action.resources.map((resource) => (
                <Choice
                  key={resource.id}
                  label={resource.label}
                  detail={resource.kind}
                  multi
                  selected={picked.has(resource.id)}
                  disabled={disabled}
                  onPress={() => toggle(resource.id)}
                />
              ))}
              {action.cursor ? (
                <Line tone="small">{t("connectSetup.moreResourcesAreAvailableReview")}</Line>
              ) : null}
            </View>
          ) : null}
          {action.type === "preview" ? (
            <View>
              <Line>{t("connectSetup.chooseTheToolsAgentsCan")}</Line>
              {action.operations.map((operation) => (
                <Choice
                  key={operation.id}
                  label={operation.label}
                  detail={operation.kind}
                  multi
                  selected={picked.has(operation.id)}
                  disabled={disabled}
                  onPress={() => toggle(operation.id)}
                />
              ))}
            </View>
          ) : null}
          {flow.formStep ? (
            <Button
              variant="primary"
              size="form"
              label={flow.submitLabel}
              busy={view.busy}
              disabled={
                disabled ||
                missingRequired ||
                (action.type === "select_account" && !choice) ||
                (action.type === "select_resources" && Boolean(action.cursor))
              }
              onPress={submit}
            />
          ) : null}
          {action.type === "authorize" ? (
            <Button
              icon="external-link"
              variant="primary"
              size="form"
              label={
                flow.navigating
                  ? t("connectSetup.waitingForAuthorization")
                  : (authorizeLabel ?? t("connectSetup.authorizeConnection"))
              }
              onPress={flow.authorize}
            />
          ) : null}
          {action.type === "wait" ? (
            <View style={{ gap: 6 }}>
              {action.userCode ? (
                <Text selectable style={text.body}>
                  {t("connectSetup.verificationCode")}{" "}
                  <Text style={fontStyle(text.theme, 600, "mono")}>{action.userCode}</Text>
                </Text>
              ) : null}
              <Line>{t("connectSetup.completeProviderAuthorizationThenCheck")}</Line>
              {flow.verificationUrl ? (
                <Button
                  icon="external-link"
                  label={t("connectSetup.openProviderVerificationPageNew")}
                  onPress={() => openLink(options, flow.verificationUrl!)}
                  style={{ alignSelf: "flex-start" }}
                />
              ) : null}
            </View>
          ) : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Button
              variant="ghost"
              label={t("connectSetup.checkStatus")}
              disabled={disabled}
              onPress={flow.refresh}
            />
            <Button
              variant="ghost"
              label={t("connectSetup.cancelSetup")}
              disabled={disabled}
              onPress={flow.cancel}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

/* -------------------------------------------------- reviewed integration -- */

type CardProps = {
  client: OpenGeniClient;
  workspaceId: string;
  sessionId: string;
  capabilityId: string;
  name: string;
  rationale: string;
  options: NativeInChatConnectOptions;
};

/** One-tap Connect for a reviewed integration: your own account, then the agent continues. */
export function NativeIntegrationCapabilityCard({
  client,
  workspaceId,
  sessionId,
  capabilityId,
  name,
  rationale,
  options,
}: CardProps) {
  const t = useOpenGeniText();
  const [windows] = useState(() => nativeConnectWindowHost(options.browser));
  const flow = useIntegrationCapabilityConnect({
    client,
    workspaceId,
    sessionId,
    capabilityId,
    name,
    returnUrl: options.returnUrl,
    windows,
  });
  const { availability, attempt, busy, waiting, error } = flow;
  const connected = availability.kind === "connected";
  const settingUp = availability.kind === "ready" && Boolean(attempt || busy || error);
  return (
    <CapabilityFrame
      name={name}
      typeLabel={t("sessionIntegrationCapabilityCard.integration")}
      description={rationale}
      complete={connected}
      completeLabel={t("sessionIntegrationCapabilityCard.connected")}
      note={t("sessionIntegrationCapabilityCard.note")}
    >
      {connected ? (
        <>
          {flow.chatAccessFailed ? (
            <Line role="alert">{t("sessionIntegrationCapabilityCard.chatAccessFailed")}</Line>
          ) : null}
          {flow.notRequester ? (
            <Line role="alert">{t("sessionIntegrationCapabilityCard.notRequester")}</Line>
          ) : null}
        </>
      ) : availability.kind === "unavailable" ? (
        <Line icon="circle-alert">{availability.reason}</Line>
      ) : availability.kind === "error" ? (
        <View style={{ gap: 8 }}>
          <Line icon="circle-alert">{t("sessionIntegrationCapabilityCard.couldNotLoad")}</Line>
          <Button
            icon="rotate-ccw"
            label={t("sessionIntegrationCapabilityCard.retry")}
            onPress={flow.reload}
            style={{ alignSelf: "flex-start" }}
          />
        </View>
      ) : settingUp ? (
        <View style={{ gap: 12 }}>
          {error ? (
            <Line tone="error" role="alert" icon="circle-alert">
              {error}
            </Line>
          ) : null}
          {attempt ? (
            <NativeConnectSetup
              controller={flow.controller}
              authorizeLabel={t("sessionIntegrationCapabilityCard.signIn")}
              onAuthorize={flow.authorizeAttempt}
              options={options}
            />
          ) : busy ? (
            <Line role="alert">{t("sessionIntegrationCapabilityCard.preparing")}</Line>
          ) : null}
          {waiting ? (
            <WaitingForSignIn
              text={t("sessionIntegrationCapabilityCard.finishSigningIn", { name })}
              stopLabel={t("sessionIntegrationCapabilityCard.stopWaiting")}
              onStop={flow.stopWaiting}
            />
          ) : null}
          {!busy && !waiting && (flow.restartable || error) ? (
            <Button
              icon="rotate-ccw"
              variant="primary"
              size="form"
              label={t("sessionIntegrationCapabilityCard.tryAgain")}
              onPress={flow.start}
            />
          ) : null}
        </View>
      ) : (
        <PrimaryAction
          label={t("sessionIntegrationCapabilityCard.connectName", { name })}
          busy={busy || availability.kind === "loading"}
          onPress={flow.start}
        />
      )}
    </CapabilityFrame>
  );
}

function WaitingForSignIn({
  text,
  stopLabel,
  onStop,
}: {
  text: string;
  stopLabel: string;
  onStop: () => void;
}) {
  const { c } = useText();
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon name="loader-circle" size={14} color={c["status-running"]} />
        <View style={{ flex: 1 }}>
          <Line tone="body" role="alert">
            {text}
          </Line>
        </View>
      </View>
      <Button
        variant="ghost"
        label={stopLabel}
        onPress={onStop}
        style={{ alignSelf: "flex-start" }}
      />
    </View>
  );
}

/* ------------------------------------------------------------ OAuth MCP -- */

/** Sign in to an OAuth MCP server, enable it with that account, add it here, continue. */
export function NativeMcpCapabilityCard({
  client,
  workspaceId,
  sessionId,
  capabilityId,
  name,
  rationale,
  personalOnly: configuredPersonalOnly,
  options,
}: CardProps & { personalOnly: boolean }) {
  const t = useOpenGeniText();
  const text = useText();
  const [windows] = useState(() => nativeConnectWindowHost(options.browser));
  const flow = useMcpCapabilityConnect({
    client,
    workspaceId,
    sessionId,
    capabilityId,
    returnUrl: options.returnUrl,
    windows,
    personalOnly: configuredPersonalOnly,
  });
  const { item, personalOnly, busy, waiting, reconciling, connected, ownership } = flow;
  const title = item?.name ?? name;
  return (
    <CapabilityFrame
      name={title}
      subtitle={item?.providerDomain ?? ""}
      typeLabel={t("sessionMcpCapabilityCard.mcpServer")}
      description={item?.description || rationale}
      complete={flow.complete}
      note={t("sessionMcpCapabilityCard.reviewAccessBeforeSigningIn")}
    >
      {flow.complete ? null : !flow.expanded ? (
        <PrimaryAction
          label={
            connected
              ? t("sessionMcpCapabilityCard.useInThisConversation")
              : t("sessionMcpCapabilityCard.connectName", { name: title })
          }
          busy={busy}
          onPress={flow.open}
        />
      ) : (
        <View style={{ gap: 12 }}>
          {flow.error ? (
            <Line tone="error" role="alert" icon="circle-alert">
              {flow.error}
            </Line>
          ) : null}
          {flow.notice ? <Line role="alert">{flow.notice}</Line> : null}
          {!item ? (
            <View style={{ gap: 8 }}>
              <Line role="alert">
                {busy
                  ? t("sessionMcpCapabilityCard.loadingConnectionDetails")
                  : t("sessionMcpCapabilityCard.connectionDetailsAreUnavailable")}
              </Line>
              <Button
                icon="rotate-ccw"
                label={t("sessionMcpCapabilityCard.retry")}
                disabled={busy}
                onPress={flow.open}
                style={{ alignSelf: "flex-start" }}
              />
            </View>
          ) : busy ? (
            waiting ? (
              <WaitingForSignIn
                text={t("sessionMcpCapabilityCard.finishSigningInWithName", { name: item.name })}
                stopLabel={t("sessionMcpCapabilityCard.stopWaiting")}
                onStop={flow.stopWaiting}
              />
            ) : (
              <Line role="alert">
                {reconciling
                  ? t("sessionMcpCapabilityCard.finishingYourConnection")
                  : t("sessionMcpCapabilityCard.preparingYourConnection")}
              </Line>
            )
          ) : !connected ? (
            <>
              {!item.connectionRef && !personalOnly ? (
                <View
                  accessibilityRole="radiogroup"
                  accessibilityLabel={t("sessionMcpCapabilityCard.whoCanUseThisConnection")}
                >
                  <Text style={text.label}>
                    {t("sessionMcpCapabilityCard.whoCanUseThisConnection")}
                  </Text>
                  <Choice
                    label={t("sessionMcpCapabilityCard.everyoneInThisWorkspace")}
                    multi={false}
                    selected={ownership === "workspace"}
                    onPress={() => flow.setOwnership("workspace")}
                  />
                  <Choice
                    label={t("sessionMcpCapabilityCard.onlyMe")}
                    multi={false}
                    selected={ownership === "personal"}
                    onPress={() => flow.setOwnership("personal")}
                  />
                </View>
              ) : null}
              <Line tone="small">
                {personalOnly && ownership === "personal"
                  ? t("sessionMcpCapabilityCard.connectsYourOwnAccountOnly")
                  : ownership === "workspace"
                    ? t("sessionMcpCapabilityCard.thisConnectionWillBeAvailable")
                    : t("sessionMcpCapabilityCard.thisConnectionBelongsToYou")}
              </Line>
              <Button
                icon="external-link"
                variant="primary"
                size="form"
                label={
                  flow.retrySignIn
                    ? t("sessionMcpCapabilityCard.trySigningInAgain")
                    : t("sessionMcpCapabilityCard.continueToName", { name: item.name })
                }
                onPress={flow.signIn}
              />
            </>
          ) : (
            <>
              <Line tone="small">{t("sessionMcpCapabilityCard.yourAccountIsConnectedEnable")}</Line>
              <Button
                icon="check"
                variant="primary"
                size="form"
                label={t("sessionMcpCapabilityCard.useInThisConversation")}
                disabled={flow.view.busy}
                onPress={flow.addHere}
              />
            </>
          )}
          {!busy ? (
            <Button
              variant="ghost"
              label={t("native.timeline.inChatConnect.close")}
              onPress={flow.close}
              style={{ alignSelf: "flex-start" }}
            />
          ) : null}
        </View>
      )}
    </CapabilityFrame>
  );
}

/* ------------------------------------------------- prepared key setup -- */

/**
 * An agent's prepared custom MCP setup: the server and its headers are
 * proposed, the person enters the requested key in the secure field.
 */
export function NativePreparedMcpSetupCard({
  client,
  workspaceId,
  sessionId,
  item,
  canConfigure,
  options,
}: {
  client: OpenGeniClient;
  workspaceId: string;
  sessionId: string;
  item: AuthNeededItem;
  canConfigure: boolean;
  options: NativeInChatConnectOptions;
}) {
  const t = useOpenGeniText();
  const setup = usePreparedMcpSetupAttempt({
    client,
    workspaceId,
    item,
    canConfigure,
    returnUrl: options.returnUrl,
  });
  const { proposal, controller, failed } = setup;
  return (
    <CapabilityFrame
      name={proposal.name}
      subtitle={proposal.endpointUrl}
      typeLabel={t("sessionMcpCapabilityCard.mcpServer")}
      description={proposal.rationale}
      complete={false}
      note={t("preparedMcpSetup.note")}
    >
      {!canConfigure ? (
        <Line icon="circle-alert">{t("preparedMcpSetup.needsManager")}</Line>
      ) : failed ? (
        <View style={{ gap: 8 }}>
          <Line tone="error" role="alert" icon="circle-alert">
            {t("preparedMcpSetup.loadFailed")}
          </Line>
          <Button
            icon="rotate-ccw"
            label={t("preparedMcpSetup.reloadSetup")}
            onPress={setup.reload}
            style={{ alignSelf: "flex-start" }}
          />
        </View>
      ) : controller ? (
        <PreparedSetup
          controller={controller}
          client={client}
          workspaceId={workspaceId}
          sessionId={sessionId}
          onRestart={setup.restart}
          options={options}
        />
      ) : (
        <Line role="alert">{t("preparedMcpSetup.preparing")}</Line>
      )}
    </CapabilityFrame>
  );
}

function PreparedSetup({
  controller,
  client,
  workspaceId,
  sessionId,
  onRestart,
  options,
}: {
  controller: ConnectController;
  client: OpenGeniClient;
  workspaceId: string;
  sessionId: string;
  onRestart: (previousId: string) => void;
  options: NativeInChatConnectOptions;
}) {
  const t = useOpenGeniText();
  const access = usePreparedMcpSetupAccess({ t, controller, client, workspaceId, sessionId });
  const attempt = access.view.attempt;
  return (
    <View style={{ gap: 12 }}>
      {access.connectedCapabilityId ? null : (
        <NativeConnectSetup
          controller={controller}
          onAuthorize={() => {
            throw new Error("Prepared key setup does not use OAuth");
          }}
          options={options}
        />
      )}
      {access.restartable && attempt ? (
        <Button
          icon="rotate-ccw"
          label={t("preparedMcpSetup.startNewSetup")}
          onPress={() => onRestart(attempt.id)}
          style={{ alignSelf: "flex-start" }}
        />
      ) : null}
      {access.connectedCapabilityId ? (
        access.access === "ready" ? (
          <Line tone="body" role="alert" icon="check">
            {t("preparedMcpSetup.connected")}
          </Line>
        ) : access.access === "failed" ? (
          <View style={{ gap: 8 }}>
            <Line role="alert" icon="circle-alert">
              {t("preparedMcpSetup.chatAccessFailed")}
            </Line>
            <Button
              icon="rotate-ccw"
              label={t("preparedMcpSetup.checkChatAccess")}
              onPress={access.recheckAccess}
              style={{ alignSelf: "flex-start" }}
            />
          </View>
        ) : (
          <Line role="alert">{t("preparedMcpSetup.checkingChatAccess")}</Line>
        )
      ) : null}
    </View>
  );
}

/* ---------------------------------------------------------- static row -- */

/**
 * A connection the chat cannot finish here: a lapsed account to reconnect, a
 * request this person cannot set up, or tools unavailable in this chat. Says
 * "reconnect" only for an account that was connected before.
 */
export function NativeAuthNeededRow({
  item,
  setupUnavailable = false,
  openUrl,
}: {
  item: AuthNeededItem;
  setupUnavailable?: boolean | undefined;
  openUrl?: ((url: string) => void) | undefined;
}) {
  const t = useOpenGeniText();
  const text = useText();
  const { theme, c } = text;
  const presentation = authNeededPresentation(t, item, { setupUnavailable });
  if (item.capability?.id === "api:connected-machine") {
    return (
      <View
        style={{
          borderRadius: theme.radius.lg,
          borderWidth: 1,
          borderColor: c.border,
          backgroundColor: c["surface-1"],
          padding: 14,
          gap: 4,
        }}
      >
        <Text style={text.label}>{t("thisComputer.card.name")}</Text>
        <Line>{t("thisComputer.card.hostSetupUnavailable")}</Line>
      </View>
    );
  }
  const link = presentation.authorizationUrl;
  return (
    <View style={{ gap: 6 }}>
      <View
        accessibilityRole="summary"
        style={{
          borderRadius: theme.radius.lg,
          borderWidth: 1,
          borderColor: presentation.unavailable ? c.border : withAlpha(c["status-waiting"], 0.35),
          backgroundColor: c["surface-1"],
          padding: 14,
          gap: 12,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Mark name={presentation.provider} />
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Text style={{ ...fontStyle(theme, 600), fontSize: theme.size.md, color: c.fg }}>
              {presentation.title}
            </Text>
            <Line>{presentation.reasonLine}</Line>
            {presentation.providerLine ? (
              <Line tone="small">{presentation.providerLine}</Line>
            ) : null}
            {presentation.variablesLine ? (
              <Line tone="small">{presentation.variablesLine}</Line>
            ) : null}
          </View>
        </View>
        {link ? (
          <Button
            icon={presentation.missing ? "plug" : "rotate-ccw"}
            variant="primary"
            size="form"
            label={presentation.actionLabel}
            onPress={() => (openUrl ? openUrl(link) : void Linking.openURL(link))}
          />
        ) : null}
      </View>
      {presentation.footnote ? (
        <View style={{ paddingHorizontal: 4 }}>
          <Line tone="small">{presentation.footnote}</Line>
        </View>
      ) : null}
    </View>
  );
}
