import { useEffect, useId, useState } from "react";
import type { AuthNeededItem } from "../../../timeline";
import { useAppContext } from "../../app-context";
import { userErrorText } from "../../../ui/api-error";
import { canAddWorkspaceIntegrations } from "../../lib/permissions";
import { Input } from "../../../ui/input";
import { Label } from "../../../ui/label";
import { SessionCapabilityFrame } from "../../../components/session-capability-frame";
import { capabilityLogoSource } from "./capability-logo-source";
import { bundledServiceLogo } from "../../../connection-service-presentation";

type Props = {
  item: AuthNeededItem;
  workspaceId: string;
  onRegistered: (id: string, restoreFocus: boolean, openSetup?: boolean) => void;
};

/**
 * A Connect card that asks for the values its integration needs before
 * signing in, such as the address of the one environment to connect. Connect
 * adds that connection (the API checks the values by the integration's own
 * rule), or finds it when it is already here, and opens its sign-in at once.
 */
export function SessionConnectInputsCard({ item, workspaceId, onRegistered }: Props) {
  const context = useAppContext();
  const capability = item.capability!;
  const inputs = capability.inputs ?? [];
  const fieldId = useId();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(inputs.map((input) => [input.id, input.value ?? ""])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canManage = canAddWorkspaceIntegrations(
    context.accessContext,
    workspaceId,
    context.workspaceMemberIntegrationSetup,
  );
  const entry = context.workspaceCapabilityCatalog.find(
    (candidate) => candidate.id === capability.id,
  );
  // The service's mark from its catalog entry, else from an example address.
  const example = inputs
    .map((input) => input.placeholder)
    .find((placeholder) => placeholder && /^https:\/\//u.test(placeholder));
  const logo =
    (entry ? capabilityLogoSource(entry, (path) => context.client.catalogAssetUrl(path)) : null) ??
    (example ? bundledServiceLogo({ id: capability.id, mcpUrl: example }) : null);
  const filled = inputs.every((input) => values[input.id]?.trim());
  useEffect(() => setError(null), [values]);

  async function connect(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !canManage || !filled) return;
    setBusy(true);
    setError(null);
    try {
      // The API applies the entry's rule to the values, and answers with the
      // connection already here when there is one, so a retry never adds two.
      const { id } = await context.client.createCapability(workspaceId, {
        kind: "mcp",
        source: "manual",
        name: capability.name,
        connectFor: capability.id,
        connectInputs: Object.fromEntries(
          inputs.map((input) => [input.id, values[input.id]?.trim() ?? ""]),
        ),
      });
      // The chat reads the new entry from the workspace catalog: reload it
      // first, so the card that follows is the connection's sign-in.
      await context.refreshWorkspaceMcpServers(workspaceId).catch(() => undefined);
      onRegistered(id, false, true);
    } catch (failure) {
      setError(userErrorText(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SessionCapabilityFrame
      name={capability.name}
      subtitle={item.providerDomain}
      logo={logo}
      typeLabel=""
      description={capability.rationale}
      clampDescription
      skill={false}
      expanded={false}
      complete={false}
      actionLabel={`Connect ${capability.name}`}
      opensDialog={false}
      note=""
      onOpen={() => undefined}
      onClose={() => undefined}
      busy={busy}
      actionUnavailable={
        canManage
          ? undefined
          : `Ask a workspace admin to add ${capability.name}. Then you can sign in here.`
      }
      inlineSetup={
        canManage ? (
          <form className="grid gap-3" onSubmit={(event) => void connect(event)}>
            {inputs.map((input, index) => (
              <div key={input.id} className="grid gap-1.5">
                <Label htmlFor={`${fieldId}-${input.id}`}>{input.label}</Label>
                <Input
                  id={`${fieldId}-${input.id}`}
                  value={values[input.id] ?? ""}
                  placeholder={input.placeholder}
                  inputMode={input.id === "endpointUrl" ? "url" : undefined}
                  maxLength={2048}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error && index === 0 ? `${fieldId}-error` : undefined}
                  onChange={(event) =>
                    setValues((current) => ({ ...current, [input.id]: event.target.value }))
                  }
                />
              </div>
            ))}
            {error ? (
              <p id={`${fieldId}-error`} role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <button
              type="submit"
              className="og-session-capability-primary"
              disabled={busy || !filled}
            >
              {busy ? "Connecting…" : "Connect"}
            </button>
          </form>
        ) : undefined
      }
    />
  );
}
