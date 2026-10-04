import type { ReactNode } from "react";

import { ProviderTile, type ModelProviderId } from "@/components/models/provider-mark";
import { ListRow, RowList } from "@/components/ui/list-row";

/* ----------------------------------------------------------------------------
   The one provider list people connect an account from: a row per provider
   with its logo, its name and how you pay. Settings > Models (Connect account)
   and the post-signup model step both render it, so a provider looks and
   reads the same everywhere.
   -------------------------------------------------------------------------- */

export type ProviderConnectChoice = {
  id: ModelProviderId;
  title: string;
  /** How you pay: "Pay with your ChatGPT plan", "Pay per token through OpenRouter". */
  summary: string;
  /** A second fact: who it is for, or what connecting it here changes. */
  note?: string | undefined;
  /** Already connected: the row says so. */
  connected?: boolean | undefined;
  /** Why this provider can't be connected here. The row stays, disabled. */
  unavailable?: string | undefined;
};

/** How a provider pays for new work, as its row's first fact. */
export function providerPaymentSummary(id: ModelProviderId, title: string): string {
  if (id === "codex") return "Pay with your ChatGPT plan";
  if (id === "supergrok") return "Pay with your SuperGrok plan";
  return `Pay per token through ${title}`;
}

export function ProviderConnectList({
  choices,
  onOpen,
  label = "Providers",
  flush = true,
  expanded,
  panel,
  disabled = false,
  leadingRows,
}: {
  choices: readonly ProviderConnectChoice[];
  onOpen: (choice: ProviderConnectChoice) => void;
  label?: string;
  flush?: boolean;
  /**
   * The provider whose connect step is open under its row. Pass it (null when
   * none is open) to expand rows in place instead of opening a page.
   */
  expanded?: ModelProviderId | null | undefined;
  /** The connect step shown under the expanded row. */
  panel?: ((choice: ProviderConnectChoice) => ReactNode) | undefined;
  /** Rows can't be opened right now (a connection is being saved). */
  disabled?: boolean;
  /** Rows before the providers in the same list, such as Opengeni credits. */
  leadingRows?: ReactNode;
}) {
  const expandable = expanded !== undefined;
  return (
    <RowList label={label} flush={flush}>
      {leadingRows}
      {choices.map((choice) =>
        choice.unavailable ? (
          <ListRow
            key={choice.id}
            disabled
            leading={<ProviderTile provider={choice.id} size="lg" />}
            title={choice.title}
            meta={[choice.summary]}
            indicator={{ kind: "unavailable", label: choice.unavailable }}
          />
        ) : (
          <ListRow
            key={choice.id}
            leading={<ProviderTile provider={choice.id} size="lg" />}
            title={choice.title}
            meta={[choice.summary, choice.connected ? "Already connected" : choice.note]}
            indicator={expandable ? "expand" : "open"}
            disabled={disabled}
            onOpen={() => onOpen(choice)}
            {...(expandable
              ? {
                  expanded: expanded === choice.id,
                  panel: expanded === choice.id ? panel?.(choice) : null,
                }
              : {})}
          />
        ),
      )}
    </RowList>
  );
}
