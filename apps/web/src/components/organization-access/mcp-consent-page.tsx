import type { McpConnectionDecision, McpConnectionRequest } from "@opengeni/sdk";
import { BotIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { OrganizationAccessFields } from "@/components/organization-access/organization-access-fields";
import { Field, FieldStack } from "@/components/ui/field";
import { FormPage } from "@/components/ui/form-dialog";
import { LogoTile } from "@/components/ui/logo-tile";
import { SelectMenu } from "@/components/ui/select-menu";
import { userErrorText } from "@/lib/api-error";
import {
  defaultPolicy,
  policyBlockedReason,
  type OrganizationAccessPolicy,
} from "@/lib/organization-access";

/* ----------------------------------------------------------------------------
   The page an agent's sign-in opens: "Connect Claude Code to Opengeni". The
   agent acts as the person signing in, never with more than they can do; the
   person picks the organization, what it can do and where. Read only in every
   workspace is the default. Allow returns to the agent.
   -------------------------------------------------------------------------- */

export function McpConsentPage({
  request,
  onAnswer,
}: {
  request: McpConnectionRequest;
  /** Resolves once the browser is on its way back to the agent. */
  onAnswer: (decision: McpConnectionDecision) => Promise<void>;
}) {
  const [organizationId, setOrganizationId] = useState(
    request.defaultOrganizationId ?? request.organizations[0]?.id ?? "",
  );
  const organization =
    request.organizations.find((each) => each.id === organizationId) ?? request.organizations[0];
  const [policy, setPolicy] = useState<OrganizationAccessPolicy>(defaultPolicy);
  const [errors, setErrors] = useState<{ permissions?: string; workspaces?: string }>({});
  const ceiling = useMemo(
    () => new Set<string>(organization?.grantable ?? []),
    [organization?.grantable],
  );
  const clientName = request.client.name;

  if (!organization) {
    return (
      <ConsentFrame>
        <FormPage
          leading={<LogoTile icon={<BotIcon />} />}
          title={`Connect ${clientName} to Opengeni`}
          description="You aren't in an organization yet, so there is nothing to connect it to."
          submitLabel="Go back to the agent"
          cancelLabel={null}
          onSubmit={async () => {
            await onAnswer({ decision: "deny" });
            return false;
          }}
        />
      </ConsentFrame>
    );
  }

  return (
    <ConsentFrame>
      <FormPage
        leading={<LogoTile icon={<BotIcon />} />}
        title={`Connect ${clientName} to Opengeni`}
        description={
          request.client.host
            ? `It acts as you, never with more than you can do. Allow returns you to ${request.client.host}.`
            : "It acts as you, never with more than you can do."
        }
        submitLabel="Allow"
        pendingLabel="Connecting…"
        onCancel={() => void onAnswer({ decision: "deny" })}
        onSubmit={async () => {
          const reason = policyBlockedReason(policy);
          if (reason) {
            setErrors(
              policy.permissions.length === 0 ? { permissions: reason } : { workspaces: reason },
            );
            return false;
          }
          try {
            await onAnswer({
              decision: "approve",
              organizationId: organization.id,
              access: policy,
            });
            return false;
          } catch (caught) {
            throw new Error(
              `${clientName} wasn't connected. ${userErrorText(caught, "Try again.")}`,
              {
                cause: caught,
              },
            );
          }
        }}
      >
        <FieldStack>
          {request.organizations.length > 1 ? (
            <Field label="Organization">
              <SelectMenu
                options={request.organizations.map((each) => ({
                  value: each.id,
                  label: each.name,
                }))}
                value={organization.id}
                onValueChange={(next) => {
                  setOrganizationId(next);
                  setPolicy(defaultPolicy());
                  setErrors({});
                }}
                className="w-full"
              />
            </Field>
          ) : null}
          <OrganizationAccessFields
            organizationName={organization.name}
            policy={policy}
            onPolicyChange={(next) => {
              setPolicy(next);
              setErrors({});
            }}
            workspaces={organization.workspaces}
            ceiling={ceiling}
            includesPersonal
            errors={errors}
          />
        </FieldStack>
      </FormPage>
    </ConsentFrame>
  );
}

/** A standalone page with the product glow, like the other sign-in pages. */
export function ConsentFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="og-page-glow flex min-h-0 flex-1 justify-center overflow-y-auto px-4 py-10 text-fg">
      <div className="w-full max-w-[640px]">{children}</div>
    </div>
  );
}
