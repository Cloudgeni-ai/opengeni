/**
 * Connect-time inputs: values a person enters on a Connect card before
 * signing in, because each connection is to one place of their own (for
 * example one customer environment's address). An integration declares them
 * here by its catalog `surfaceType`, with the rule that turns the entered
 * values into the connection's endpoint. The agent's card tool, the card and
 * the API that adds the connection all use this same rule.
 */
import {
  microsoftDynamicsAddressProblem,
  microsoftDynamicsMcpEndpoint,
} from "./microsoft-dynamics";

/** One value a person enters on a Connect card. */
export type CapabilityConnectInput = {
  /** The field's key, also the key an agent uses to prefill it. */
  id: string;
  /** The field's label on the card. */
  label: string;
  /** An example value shown in the empty field. */
  placeholder?: string | undefined;
};

/** The connection endpoint for entered values, or why they can't be used (for the person). */
export type CapabilityConnectEndpoint = { endpointUrl: string } | { problem: string };

type ConnectInputsDeclaration = {
  inputs: readonly CapabilityConnectInput[];
  endpoint(values: Readonly<Record<string, string>>): CapabilityConnectEndpoint;
};

const DECLARATIONS: Readonly<Record<string, ConnectInputsDeclaration>> = {
  // Each connection is one Dynamics environment, named by its address.
  microsoft_dynamics: {
    inputs: [
      {
        id: "endpointUrl",
        label: "Environment address",
        placeholder: "https://contoso.crm4.dynamics.com",
      },
    ],
    endpoint: ({ endpointUrl = "" }) => {
      const resolved = microsoftDynamicsMcpEndpoint(endpointUrl);
      if (resolved) return { endpointUrl: resolved.mcpUrl };
      return {
        problem:
          microsoftDynamicsAddressProblem(endpointUrl) ??
          "That isn't a Dynamics environment address. Paste the address you open Dynamics at, for example https://contoso.crm4.dynamics.com.",
      };
    },
  },
};

/** The inputs a catalog entry's Connect card asks for, or null when it asks for none. */
export function capabilityConnectInputs(
  surfaceType: string | null | undefined,
): readonly CapabilityConnectInput[] | null {
  return (surfaceType && DECLARATIONS[surfaceType]?.inputs) || null;
}

/**
 * The connection endpoint for values entered on a catalog entry's Connect
 * card, or why they can't be used. Null when the entry asks for no inputs.
 */
export function capabilityConnectEndpoint(
  surfaceType: string | null | undefined,
  values: Readonly<Record<string, string>>,
): CapabilityConnectEndpoint | null {
  const declaration = surfaceType ? DECLARATIONS[surfaceType] : undefined;
  if (!declaration) return null;
  const trimmed = Object.fromEntries(
    declaration.inputs.map((input) => [input.id, (values[input.id] ?? "").trim()]),
  );
  const missing = declaration.inputs.find((input) => !trimmed[input.id]);
  if (missing) return { problem: `Enter the ${missing.label.toLowerCase()}.` };
  return declaration.endpoint(trimmed);
}
