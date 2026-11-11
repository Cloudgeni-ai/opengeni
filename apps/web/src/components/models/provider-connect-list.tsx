import type { ReactNode } from "react";

import {
  ProviderTile,
  type ModelProviderId,
} from "@opengeni/react/app/components/models/provider-mark";
import { ListRow, RowList } from "@opengeni/react/ui/list-row";

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
  // "OpenAI API" pays through OpenAI.
  return `Pay per token through ${title.replace(/ API$/, "")}`;
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
  groupRow,
  groupChoices,
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
  /**
   * A row after the providers that opens a group of more providers, such as
   * pay-per-token accounts. The group's rows follow it in the same list,
   * indented under it, so a connect step opened from one loses only that
   * small indent of width.
   */
  groupRow?: ReactNode;
  /** The group's providers, shown under `groupRow`; empty while the group is closed. */
  groupChoices?: readonly ProviderConnectChoice[];
}) {
  const expandable = expanded !== undefined;
  const row = (choice: ProviderConnectChoice, nested = false) =>
    choice.unavailable ? (
      <ListRow
        key={choice.id}
        nested={nested}
        disabled
        leading={<ProviderTile provider={choice.id} size="lg" />}
        title={choice.title}
        meta={[choice.summary]}
        indicator={{ kind: "unavailable", label: choice.unavailable }}
      />
    ) : (
      <ListRow
        key={choice.id}
        nested={nested}
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
    );
  return (
    <RowList label={label} flush={flush}>
      {leadingRows}
      {choices.map((choice) => row(choice))}
      {groupRow}
      {groupChoices?.map((choice) => row(choice, true))}
    </RowList>
  );
}
