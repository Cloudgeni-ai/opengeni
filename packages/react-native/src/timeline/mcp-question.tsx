import {
  isMcpElicitationUrlQuestion,
  mcpElicitationChoices,
  mcpElicitationDefaults,
  mcpElicitationUrlHost,
  resolveMcpElicitationContent,
  type McpElicitationApprovalRequest,
  type McpElicitationContent,
  type McpElicitationField,
  type McpElicitationUrlQuestion,
  type McpElicitationValue,
} from "@opengeni/contracts/mcp-elicitation";
import { useOpenGeniText } from "@opengeni/react/messages";
import { Pressable, Text, TextInput, View } from "react-native";
import { useOpenNativeLink } from "../links";
import { Button } from "./controls";
import { Selector } from "./selector";
import { fontStyle, useNativeTimelineTheme } from "./theme";

/*
 * An MCP server's question in the middle of a tool call, as native fields: the
 * same form the web approval card shows, answered with the approval. Numbers
 * and dates are typed as text and checked against the server's form on send. A
 * question that asks the person to open a web page shows a button naming the
 * page's host, which opens it in the browser.
 */

type DraftValue = string | boolean | string[] | undefined;
/** What the person has entered, per question id and field. */
export type McpQuestionDraft = Record<string, Record<string, DraftValue>>;

/** The server's own defaults, as the starting answer. */
export function initialMcpQuestionDraft(
  elicitation: McpElicitationApprovalRequest,
): McpQuestionDraft {
  return Object.fromEntries(
    elicitation.requests.flatMap((request) =>
      isMcpElicitationUrlQuestion(request)
        ? []
        : [
            [
              request.id,
              Object.fromEntries(
                Object.entries(mcpElicitationDefaults(request.requestedSchema)).map(
                  ([name, value]) => [name, typeof value === "number" ? String(value) : value],
                ),
              ),
            ],
          ],
    ),
  );
}

/**
 * The answer to send, without fields left empty, or the first problem with it
 * (the same check the server applies to the decision).
 */
export function mcpQuestionAnswer(
  elicitation: McpElicitationApprovalRequest,
  draft: McpQuestionDraft,
): { ok: true; content: McpElicitationContent } | { ok: false; problem: string } {
  const content: McpElicitationContent = {};
  for (const request of elicitation.requests) {
    if (isMcpElicitationUrlQuestion(request)) continue;
    const values: Record<string, McpElicitationValue> = {};
    for (const [name, raw] of Object.entries(draft[request.id] ?? {})) {
      if (raw === undefined || raw === "") continue;
      const field = request.requestedSchema.properties[name];
      if (!field) continue;
      if ((field.type === "number" || field.type === "integer") && typeof raw === "string") {
        // A decimal comma is how many keyboards type a decimal point.
        values[name] = Number(raw.trim().replace(",", "."));
      } else if (field.type === "string" && "format" in field && field.format === "date-time") {
        const parsed = typeof raw === "string" ? new Date(raw.trim().replace(" ", "T")) : null;
        values[name] = parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : raw;
      } else {
        values[name] = raw;
      }
    }
    content[request.id] = values;
  }
  const resolved = resolveMcpElicitationContent(elicitation, content);
  return resolved.ok ? { ok: true, content } : resolved;
}

/** The server's messages and form fields; the card around it holds Decline and send. */
export function McpQuestionFields({
  elicitation,
  draft,
  disabled,
  onChange,
}: {
  elicitation: McpElicitationApprovalRequest;
  draft: McpQuestionDraft;
  disabled: boolean;
  onChange: (requestId: string, name: string, value: DraftValue) => void;
}) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  return (
    <View style={{ gap: 12 }}>
      {elicitation.requests.map((request) => (
        <View key={request.id} style={{ gap: 12 }}>
          {request.message ? (
            <Text
              selectable
              style={{ ...fontStyle(theme), fontSize: theme.size.sm, lineHeight: 20, color: c.fg }}
            >
              {request.message}
            </Text>
          ) : null}
          {isMcpElicitationUrlQuestion(request) ? (
            <PageToOpen request={request} disabled={disabled} />
          ) : (
            Object.entries(request.requestedSchema.properties).map(([name, field]) => (
              <McpQuestionField
                key={name}
                name={name}
                field={field}
                required={(request.requestedSchema.required ?? []).includes(name)}
                value={draft[request.id]?.[name]}
                disabled={disabled}
                onChange={(value) => onChange(request.id, name, value)}
              />
            ))
          )}
        </View>
      ))}
    </View>
  );
}

/** Opens the page a server asks the person to visit, naming its exact host. */
function PageToOpen({
  request,
  disabled,
}: {
  request: McpElicitationUrlQuestion;
  disabled: boolean;
}) {
  const t = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const openLink = useOpenNativeLink();
  const host = mcpElicitationUrlHost(request.url);
  if (!host) return null;
  return (
    <View style={{ gap: 6, alignItems: "flex-start" }}>
      <Button
        icon="external-link"
        variant="secondary"
        size="form"
        label={t("approvalSurface.openPage", { host })}
        disabled={disabled}
        onPress={() => openLink(request.url)}
      />
      <Text
        style={{
          ...fontStyle(theme),
          fontSize: theme.size.xs,
          lineHeight: 16,
          color: theme.colors["fg-muted"],
        }}
      >
        {t("approvalSurface.openPageHint")}
      </Text>
    </View>
  );
}

function McpQuestionField({
  name,
  field,
  required,
  value,
  disabled,
  onChange,
}: {
  name: string;
  field: McpElicitationField;
  required: boolean;
  value: DraftValue;
  disabled: boolean;
  onChange: (value: DraftValue) => void;
}) {
  const t = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const label = field.title ?? name;
  const labelStyle = {
    ...fontStyle(theme, 500),
    fontSize: theme.size.sm,
    lineHeight: 18,
    color: c.fg,
  };
  const heading = (
    <Text style={labelStyle}>
      {label}
      {required ? null : (
        <Text style={{ ...fontStyle(theme), fontSize: theme.size.xs, color: c["fg-subtle"] }}>
          {`  ${t("approvalSurface.optional")}`}
        </Text>
      )}
    </Text>
  );
  const help = field.description ? (
    <Text
      style={{
        ...fontStyle(theme),
        fontSize: theme.size.xs,
        lineHeight: 16,
        color: c["fg-muted"],
      }}
    >
      {field.description}
    </Text>
  ) : null;
  if (field.type === "boolean") {
    return (
      <View style={{ gap: 2 }}>
        <Pressable
          accessibilityRole="checkbox"
          accessibilityLabel={label}
          accessibilityState={{ checked: value === true, disabled }}
          disabled={disabled}
          onPress={() => onChange(value !== true)}
          style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, minHeight: 36 }}
        >
          <Selector multi selected={value === true} />
          <View style={{ flex: 1, minWidth: 0 }}>{heading}</View>
        </Pressable>
        {help}
      </View>
    );
  }
  const choices = mcpElicitationChoices(field);
  if (choices) {
    const multi = field.type === "array";
    const selected = multi ? ((value as string[] | undefined) ?? []) : [value];
    return (
      <View style={{ gap: 2 }}>
        {heading}
        {help}
        {choices.map((choice) => {
          const checked = selected.includes(choice.value);
          return (
            <Pressable
              key={choice.value}
              accessibilityRole={multi ? "checkbox" : "radio"}
              accessibilityLabel={choice.label}
              accessibilityState={{ checked, disabled }}
              disabled={disabled}
              onPress={() => {
                if (!multi) return onChange(choice.value);
                const current = (value as string[] | undefined) ?? [];
                onChange(
                  checked
                    ? current.filter((item) => item !== choice.value)
                    : [...current, choice.value],
                );
              }}
              style={{
                flexDirection: "row",
                alignItems: "flex-start",
                gap: 10,
                minHeight: 36,
                paddingVertical: 8,
              }}
            >
              <Selector multi={multi} selected={checked} />
              <Text
                style={{
                  ...fontStyle(theme),
                  flex: 1,
                  fontSize: theme.size.sm,
                  lineHeight: 18,
                  color: c.fg,
                }}
              >
                {choice.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    );
  }
  const format = field.type === "string" && "format" in field ? field.format : undefined;
  const numeric = field.type === "number" || field.type === "integer";
  const long =
    !numeric &&
    !format &&
    !(field.type === "string" && "maxLength" in field && (field.maxLength ?? Infinity) <= 200);
  return (
    <View style={{ gap: 4 }}>
      {heading}
      {help}
      <TextInput
        accessibilityLabel={label}
        editable={!disabled}
        value={typeof value === "string" ? value : ""}
        onChangeText={(text) => onChange(text || undefined)}
        multiline={long}
        autoCapitalize={format === "email" || format === "uri" ? "none" : "sentences"}
        autoCorrect={!format}
        keyboardType={
          numeric
            ? field.type === "integer"
              ? "number-pad"
              : "decimal-pad"
            : format === "email"
              ? "email-address"
              : format === "uri"
                ? "url"
                : "default"
        }
        placeholder={
          format === "date" ? "YYYY-MM-DD" : format === "date-time" ? "YYYY-MM-DD HH:MM" : undefined
        }
        placeholderTextColor={c["fg-subtle"]}
        style={{
          ...fontStyle(theme),
          fontSize: theme.size.sm,
          color: c.fg,
          minHeight: long ? 64 : 36,
          paddingHorizontal: 8,
          paddingVertical: 6,
          borderRadius: theme.radius.sm,
          borderWidth: 1,
          borderColor: c.border,
          backgroundColor: c["surface-1"],
          ...(long ? { textAlignVertical: "top" as const } : {}),
        }}
      />
    </View>
  );
}
