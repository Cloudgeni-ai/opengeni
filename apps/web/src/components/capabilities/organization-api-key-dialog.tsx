import type { ReactNode } from "react";
import { useState } from "react";

import {
  ApiKeyFields,
  apiKeyPlacements,
  EMPTY_API_KEY,
  type ApiKeyValues,
} from "@/components/capabilities/api-key-fields";
import {
  customApiConnectionRequest,
  emptyCustomApiDraft,
} from "@/components/capabilities/custom-api-flow";
import type {
  ApiIntegrationInstallationSummary,
  CreateConnectionRequest,
} from "@opengeni/react/app/types";
import { userErrorText } from "@opengeni/react/ui/api-error";
import { FieldStack } from "@opengeni/react/ui/field";
import { FormDialog } from "@opengeni/react/ui/form-dialog";

/** "key" or "token": what a person adds for an organization's API. */
export function organizationApiKeyNoun(instance: ApiIntegrationInstallationSummary): string {
  return instance.organizationConnector?.auth.kind === "api_key" ? "key" : "token";
}

/**
 * The Only me connection a person's own key becomes: the provider and kind
 * the organization's "each person signs in" API runs through.
 */
export function organizationApiOwnKeyRequest(
  instance: ApiIntegrationInstallationSummary,
  values: ApiKeyValues,
): { request: CreateConnectionRequest } | { issue: string } {
  const auth = instance.organizationConnector?.auth;
  if (!auth || auth.kind === "none") return { issue: "This API needs no key." };
  const keyed = apiKeyPlacements(auth, values);
  if ("issue" in keyed) return keyed;
  return {
    request: customApiConnectionRequest({
      preview: { auth },
      draft: {
        ...emptyCustomApiDraft(),
        ownership: "personal",
        displayName: instance.displayName,
        credentialValue: values.value.trim(),
        username: values.username.trim(),
        password: values.password,
      },
      providerDomain: instance.providerDomain,
    }),
  };
}

/**
 * A person adds their own key for an API their organization added with "each
 * person signs in". It is theirs alone (Only me); nobody else's chats use it.
 */
export function OrganizationApiKeyDialog({
  instance,
  onOpenChange,
  onAdd,
}: {
  /** The organization API to add a key for; null keeps the dialog closed. */
  instance: ApiIntegrationInstallationSummary | null;
  onOpenChange: (open: boolean) => void;
  onAdd: (request: CreateConnectionRequest) => Promise<void>;
}) {
  const [values, setValues] = useState<ApiKeyValues>(EMPTY_API_KEY);
  const [error, setError] = useState<string | undefined>();
  const [formError, setFormError] = useState<ReactNode>(null);
  const auth = instance?.organizationConnector?.auth ?? null;
  const noun = instance ? organizationApiKeyNoun(instance) : "key";
  return (
    <FormDialog
      open={instance !== null}
      onOpenChange={(open) => {
        if (!open) {
          setValues(EMPTY_API_KEY);
          setError(undefined);
          setFormError(null);
        }
        onOpenChange(open);
      }}
      title={instance ? `Add your ${noun} for ${instance.displayName}` : `Add your ${noun}`}
      description={
        instance
          ? `Your organization added ${instance.displayName} for each person to use with their own ${noun}. Only you can use yours.`
          : undefined
      }
      submitLabel={`Add ${noun}`}
      pendingLabel="Adding…"
      error={formError}
      onSubmit={async (event) => {
        event.preventDefault();
        setFormError(null);
        if (!instance) return false;
        const built = organizationApiOwnKeyRequest(instance, values);
        if ("issue" in built) {
          setError(built.issue);
          return false;
        }
        try {
          await onAdd(built.request);
          setValues(EMPTY_API_KEY);
          return true;
        } catch (caught) {
          setFormError(userErrorText(caught));
          return false;
        }
      }}
    >
      {auth && auth.kind !== "none" ? (
        <FieldStack>
          <ApiKeyFields
            auth={auth}
            values={values}
            onChange={(next) => {
              setValues(next);
              setError(undefined);
            }}
            error={error}
          />
        </FieldStack>
      ) : null}
    </FormDialog>
  );
}
