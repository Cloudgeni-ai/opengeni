import type { ComputerConnectLink } from "@opengeni/sdk/app-links";
import type { StoredAccount } from "./accounts";

/** The account selected for a web handoff must be exact, never the last active account. */
export function computerLinkAccount(
  link: ComputerConnectLink,
  accounts: readonly StoredAccount[],
): StoredAccount | null {
  return (
    accounts.find(
      (account) =>
        !account.signedOut &&
        account.baseUrl === link.origin &&
        account.subjectId === link.subjectId,
    ) ?? null
  );
}

/** Authorization precedes local consent; an external URL alone never connects a computer. */
export async function completeComputerLink(input: {
  link: ComputerConnectLink;
  account: StoredAccount;
  workspace: (id: string) => Promise<{ name: string }>;
  confirm: (workspaceName: string) => Promise<boolean>;
  connect: (workspaceId: string) => Promise<void>;
  navigate: (path: string) => void;
}): Promise<boolean> {
  const { link, account } = input;
  if (!link.workspaceId || computerLinkAccount(link, [account]) === null) return false;
  const workspace = await input.workspace(link.workspaceId);
  if (!(await input.confirm(workspace.name))) return false;
  input.navigate(new URL(link.webUrl).pathname);
  await input.connect(link.workspaceId);
  return true;
}
