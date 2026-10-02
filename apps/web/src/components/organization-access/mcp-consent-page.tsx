import { BotIcon } from "lucide-react";
import { useMemo, useState } from "react";

import {
  OrganizationAccessFields,
  type AccessWorkspace,
} from "@/components/organization-access/organization-access-fields";
import { Field, FieldStack } from "@/components/ui/field";
import { FormPage } from "@/components/ui/form-dialog";
import { LogoTile } from "@/components/ui/logo-tile";
import { SelectMenu } from "@/components/ui/select-menu";
import { userErrorText } from "@/lib/api-error";
import {
  DEFAULT_POLICY,
  policyBlockedReason,
  type OrganizationAccessPolicy,
  type OrganizationActor,
} from "@/lib/organization-access";

/* ----------------------------------------------------------------------------
   The page an agent's sign-in opens: "Connect Claude Code to Opengeni".
   The person picks the organization, who the agent acts as, what it can do
   and where, then Allow returns to the agent. Read only, every workspace and
   acting as you is the default: the least surprising grant.
   -------------------------------------------------------------------------- */

export type McpConsentOrganization = {
  id: string;
  name: string;
  /** Owners and admins can connect an agent as the organization. */
  canActAsOrganization: boolean;
  /** Workspaces the person can open there, their Personal one marked. */
  workspaces: AccessWorkspace[];
  /** What the person can hand out as themselves. */
  grantable: string[];
};

export type McpConsentRequest = {
  client: { name: string; host: string | null };
  person: { name: string };
  organizations: McpConsentOrganization[];
  defaultOrganizationId: string;
};

export type McpConsentDecision = {
  organizationId: string;
  actor: OrganizationActor;
  policy: OrganizationAccessPolicy;
};

export function McpConsentPage({
  request,
  onAllow,
  onCancel,
}: {
  request: McpConsentRequest;
  /** Resolves when the browser is on its way back to the agent. */
  onAllow: (decision: McpConsentDecision) => Promise<void>;
  onCancel: () => void;
}) {
  const [organizationId, setOrganizationId] = useState(request.defaultOrganizationId);
  const organization =
    request.organizations.find((each) => each.id === organizationId) ?? request.organizations[0]!;
  const [actor, setActor] = useState<OrganizationActor>("user");
  const [policy, setPolicy] = useState<OrganizationAccessPolicy>(DEFAULT_POLICY);
  const [errors, setErrors] = useState<{ permissions?: string; workspaces?: string }>({});
  const grantable = useMemo(() => new Set(organization.grantable), [organization.grantable]);

  return (
    <main className="og-page-glow flex min-h-dvh flex-1 justify-center px-4 py-10 text-fg">
      <div className="w-full max-w-[640px]">
        <FormPage
          leading={<LogoTile icon={<BotIcon />} />}
          title={`Connect ${request.client.name} to Opengeni`}
          description={
            request.client.host
              ? `It will work as you choose below. Allow returns you to ${request.client.host}.`
              : "It will work as you choose below."
          }
          submitLabel="Allow"
          pendingLabel="Connecting…"
          onCancel={onCancel}
          onSubmit={async () => {
            const reason = policyBlockedReason(policy);
            if (reason) {
              setErrors(
                policy.permissions.length === 0 ? { permissions: reason } : { workspaces: reason },
              );
              return false;
            }
            try {
              await onAllow({ organizationId: organization.id, actor, policy });
              return false;
            } catch (caught) {
              throw new Error(
                `${request.client.name} wasn't connected. ${userErrorText(caught, "Try again.")}`,
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
                    setActor("user");
                    setPolicy(DEFAULT_POLICY);
                    setErrors({});
                  }}
                  className="w-full"
                />
              </Field>
            ) : null}
            <OrganizationAccessFields
              organizationName={organization.name}
              actor={{
                value: actor,
                onChange: setActor,
                personName: request.person.name,
                organizationUnavailableReason: organization.canActAsOrganization
                  ? null
                  : "Only organization owners and admins can connect an agent as the organization.",
              }}
              policy={policy}
              onPolicyChange={(next) => {
                setPolicy(next);
                setErrors({});
              }}
              workspaces={organization.workspaces}
              grantable={grantable}
              errors={errors}
            />
          </FieldStack>
        </FormPage>
      </div>
    </main>
  );
}
