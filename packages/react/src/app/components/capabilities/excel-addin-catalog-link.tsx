import { Button } from "../../../ui/button";
import type { CapabilityCatalogItem } from "../../types";

/** The add-in's name and install page, as the API projected them onto its tile. */
export function excelAddinDetails(item: Pick<CapabilityCatalogItem, "metadata">): {
  name: string;
  installUrl: string | null;
} {
  const { addinName, installUrl } = item.metadata;
  return {
    name: typeof addinName === "string" && addinName ? addinName : "Opengeni",
    installUrl: typeof installUrl === "string" && installUrl ? installUrl : null,
  };
}

/** Opens the add-in's install-and-connect page; the add-in lives in each person's own Excel. */
export function ExcelAddinCatalogLink({
  item,
  preserveChat = false,
}: {
  item: Pick<CapabilityCatalogItem, "metadata">;
  preserveChat?: boolean | undefined;
}) {
  const { installUrl } = excelAddinDetails(item);
  if (!installUrl) return null;
  return (
    <Button asChild className="rounded-[10px] pointer-coarse:h-11">
      <a
        href={installUrl}
        target={preserveChat ? "_blank" : undefined}
        rel={preserveChat ? "noopener noreferrer" : undefined}
      >
        Add to Excel
      </a>
    </Button>
  );
}

/** What the add-in does and the three steps to start using it. */
export function ExcelAddinSetupSteps({
  item,
  preserveChat = false,
}: {
  item: Pick<CapabilityCatalogItem, "metadata">;
  preserveChat?: boolean | undefined;
}) {
  const { name, installUrl } = excelAddinDetails(item);
  if (!installUrl) {
    return (
      <p className="text-sm text-fg-muted">
        The Excel add-in is not set up on this deployment yet.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <ol className="list-decimal space-y-1 pl-5 text-sm text-fg-muted">
        <li>
          Add {name} to Excel{preserveChat ? " (opens in a new tab)" : ""}. It works in Excel on the
          web, Windows and Mac.
        </li>
        <li>Open a workbook and choose Home &gt; Add-ins &gt; {name}, then sign in.</li>
        <li>Chat in the pane, or ask an agent in any chat to work in that workbook.</li>
      </ol>
      <ExcelAddinCatalogLink item={item} preserveChat={preserveChat} />
    </div>
  );
}
