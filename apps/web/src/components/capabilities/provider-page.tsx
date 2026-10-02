import type { ReactNode } from "react";

import { CapabilityPage, CapabilityStatus } from "@/components/capabilities/capability-page";
import { DetailSection } from "@/components/ui/detail-sheet";
import { ListRow, RowList } from "@/components/ui/list-row";

/* ----------------------------------------------------------------------------
   One provider, several ways to use it (Slack: the OpenGeni bot or your own
   account; Jira & Confluence: knowledge sync or agent tools). The catalog
   shows the provider once; this page asks for the outcome, and each row opens
   that mode's own page (DESIGN.md section 7: the connect page is a list of
   rows, each opening its own step).
   -------------------------------------------------------------------------- */

export type ProviderMode = {
  id: string;
  /** The outcome, verb first: "Add OpenGeni to Slack". */
  title: string;
  /** Who it is for and what happens: "Everyone can chat with it in Slack." */
  description: string;
  /** A status label from the Capabilities vocabulary ("Connected", "Needs attention"). */
  status?: string;
  onOpen: () => void;
};

export function ProviderPage({
  name,
  mark,
  description,
  modes,
  onBack,
}: {
  name: string;
  mark: ReactNode;
  description: string;
  modes: ProviderMode[];
  onBack: () => void;
}) {
  const connected = modes.some((mode) => mode.status === "Connected");
  const attention = modes.some((mode) => mode.status === "Needs attention");
  return (
    <CapabilityPage
      onBack={onBack}
      mark={mark}
      title={name}
      status={attention ? "Needs attention" : connected ? "Connected" : undefined}
      meta={[description]}
    >
      <DetailSection
        title={`How do you want to use ${name}?`}
        description="You can set up both. Each one is connected separately."
      >
        <RowList label={`Ways to use ${name}`} flush>
          {modes.map((mode) => (
            <ListRow
              key={mode.id}
              title={mode.title}
              titleAddon={mode.status ? <CapabilityStatus label={mode.status} /> : undefined}
              meta={[mode.description]}
              indicator="open"
              onOpen={mode.onOpen}
            />
          ))}
        </RowList>
      </DetailSection>
    </CapabilityPage>
  );
}
