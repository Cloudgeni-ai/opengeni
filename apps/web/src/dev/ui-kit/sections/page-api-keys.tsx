import { KitBlock, KitSection } from "../kit";
import { PicksInUse, SettingsPreview } from "../pages/settings/preview";

export default function PageApiKeysSection() {
  return (
    <KitSection sectionKey="page-api-keys">
      <KitBlock
        title="Page"
        description="API keys inside the app, built from your picks. A key opens as its own page with a back link; revoke it there. Create API key is a page too, and the token shows once on it. The revoked and expired keys sit at the bottom. In a frame narrower than 1208px the main rail folds to icons, so the page keeps its 720px column."
      >
        <SettingsPreview initialPage="api-keys" label="API keys" />
      </KitBlock>
      <PicksInUse
        keys={[
          "navigation",
          "page-header",
          "list-row",
          "detail-sheet",
          "form-dialog",
          "select",
          "destructive-confirm",
          "disclosure",
          "empty-state",
          "status-badge",
        ]}
      />
    </KitSection>
  );
}
