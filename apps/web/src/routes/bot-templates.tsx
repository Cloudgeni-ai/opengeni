// Bot templates: where a new bot starts. The page lives in the shared app
// package; this route owns the scroll frame.
import { BotTemplatesPage } from "@opengeni/react/app/components/bots/bot-templates-page";
import { ContentPage } from "@opengeni/react/ui/content-layout";

/** Detail pages draw their own 960px frame, back link and padding. */
const PAGE_FRAME = "max-w-none px-0 py-0 pb-0 sm:px-0 lg:px-0";

export function BotTemplatesRoute({ workspaceId }: { workspaceId: string }) {
  return (
    <ContentPage width="standard" className={PAGE_FRAME}>
      <BotTemplatesPage workspaceId={workspaceId} />
    </ContentPage>
  );
}
