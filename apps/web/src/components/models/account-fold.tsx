import { Fragment, useState, type ReactNode } from "react";
import { RowButton } from "@opengeni/react/ui/page-actions";

/** One account row in a provider group, with what the group's heading counts. */
export interface GroupEntry {
  key: string;
  node: ReactNode;
  /** Turned on and working. */
  on: boolean;
  /** Signed out or failing: needs reconnecting. */
  attention: boolean;
}

export function groupEntry(
  key: string,
  account: { allocatorEnabled?: boolean; status: string },
  node: ReactNode,
  /** Not in use where it's listed, whatever the account says. */
  off = false,
): GroupEntry {
  const attention = account.status !== "active";
  return { key, node, on: !off && !attention && account.allocatorEnabled !== false, attention };
}

/** A group shows its accounts in use first; ones turned off fold away once there are several. */
export const FOLD_OFF_AFTER = 4;

/**
 * A provider's account rows: in use (or needing reconnecting) first, then the
 * ones turned off, folded behind one button once there are several. The same
 * on the organization's defaults and on one workspace's view.
 */
export function AccountGroupRows({
  title,
  entries,
  showOff: controlledShowOff,
  onShowOff,
}: {
  title: string;
  entries: readonly GroupEntry[];
  showOff?: boolean | undefined;
  onShowOff?: ((value: boolean) => void) | undefined;
}) {
  const [localShowOff, setLocalShowOff] = useState(false);
  const showOff = controlledShowOff ?? localShowOff;
  const setShowOff = onShowOff ?? setLocalShowOff;
  const first = entries.filter((entry) => entry.on || entry.attention);
  const off = entries.filter((entry) => !entry.on && !entry.attention);
  const fold = entries.length > FOLD_OFF_AFTER && off.length > 0;
  const shown = fold && !showOff ? first : [...first, ...off];
  return (
    <>
      {shown.map((entry) => (
        <Fragment key={entry.key}>{entry.node}</Fragment>
      ))}
      {fold ? (
        <li className="col-span-full list-none px-3 py-2">
          <RowButton
            aria-expanded={showOff}
            aria-label={`${showOff ? "Hide" : "Show"} ${off.length} ${title} ${off.length === 1 ? "account" : "accounts"} turned off`}
            onClick={() => setShowOff(!showOff)}
          >
            {showOff ? "Hide turned off" : `Show ${off.length} turned off`}
          </RowButton>
        </li>
      ) : null}
    </>
  );
}
