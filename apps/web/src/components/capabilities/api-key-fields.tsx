import type { ApiIntegrationAuthPreview, OrganizationApiKeyPlacement } from "@opengeni/contracts";

import {
  customApiCredentialPlacement,
  emptyCustomApiDraft,
} from "@/components/capabilities/custom-api-flow";
import { Field, TextInput } from "@opengeni/react/ui/field";

/* ----------------------------------------------------------------------------
   The key an API integration sends, as the API's own authentication defines
   it: one key (header, query parameter or cookie), a token for an HTTP scheme
   such as Bearer, or a username and password for HTTP Basic. Used for an
   organization's key and for a person's own key to an organization's API.
   -------------------------------------------------------------------------- */

export type ApiKeyValues = { value: string; username: string; password: string };

export const EMPTY_API_KEY: ApiKeyValues = { value: "", username: "", password: "" };

const CARRIER_LABEL = { header: "header", query: "query parameter", cookie: "cookie" } as const;

function isBasic(auth: ApiIntegrationAuthPreview): boolean {
  return auth.kind === "http" && /^basic$/iu.test(auth.scheme.trim());
}

function schemeLabel(scheme: string): string {
  return /^bearer$/iu.test(scheme.trim()) ? "Bearer" : scheme.trim();
}

/** "Sent as the X-Api-Key header." */
export function apiKeyDestination(auth: ApiIntegrationAuthPreview): string {
  switch (auth.kind) {
    case "api_key":
      return `Sent as the ${auth.name} ${CARRIER_LABEL[auth.carrier]}.`;
    case "http":
      return isBasic(auth)
        ? "Sent with HTTP Basic sign-in."
        : `Sent in the Authorization header as ${schemeLabel(auth.scheme)}.`;
    case "oauth2":
      return "Sent in the Authorization header as Bearer.";
    case "none":
      return "";
  }
}

/** Where the key goes and what is sent, or what's still missing. */
export function apiKeyPlacements(
  auth: ApiIntegrationAuthPreview,
  values: ApiKeyValues,
): { placements: OrganizationApiKeyPlacement[] } | { issue: string } {
  if (isBasic(auth)) {
    if (!values.username.trim()) return { issue: "Enter the username." };
    if (!values.password) return { issue: "Enter the password." };
  } else if (!values.value.trim()) {
    return { issue: auth.kind === "api_key" ? "Paste the key." : "Paste the token." };
  }
  const placement = customApiCredentialPlacement(
    { auth },
    {
      ...emptyCustomApiDraft(),
      credentialValue: values.value.trim(),
      username: values.username.trim(),
      password: values.password,
    },
  );
  return { placements: [placement] };
}

export function ApiKeyFields({
  auth,
  values,
  onChange,
  error,
}: {
  auth: ApiIntegrationAuthPreview;
  values: ApiKeyValues;
  onChange: (next: ApiKeyValues) => void;
  error?: string | undefined;
}) {
  const hint = `${apiKeyDestination(auth)} Stored encrypted. Nobody can read it back.`;
  if (isBasic(auth))
    return (
      <>
        <Field label="Username">
          <TextInput
            value={values.username}
            onChange={(event) => onChange({ ...values, username: event.target.value })}
            autoComplete="off"
            suppressAutofill
          />
        </Field>
        <Field label="Password" error={error} hint={hint}>
          <TextInput
            type="password"
            value={values.password}
            onChange={(event) => onChange({ ...values, password: event.target.value })}
            autoComplete="off"
            suppressAutofill
          />
        </Field>
      </>
    );
  return (
    <Field
      label={auth.kind === "api_key" ? "Key" : auth.kind === "oauth2" ? "Access token" : "Token"}
      error={error}
      hint={hint}
    >
      <TextInput
        type="password"
        value={values.value}
        onChange={(event) => onChange({ ...values, value: event.target.value })}
        autoComplete="off"
        suppressAutofill
      />
    </Field>
  );
}
