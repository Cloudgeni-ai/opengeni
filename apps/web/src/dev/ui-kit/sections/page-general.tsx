import { KitBlock, KitSection } from "../kit";
import { PicksInUse, SettingsPreview } from "../pages/settings/preview";

export default function PageGeneralSection() {
  return (
    <KitSection sectionKey="page-general">
      <KitBlock
        title="Page"
        description="General inside the app, built from your picks. Everything works on fixtures: rename (a small dialog, one field), pause, the session defaults, connecting AI Gateway (its own page) and deleting the workspace. The sub-nav moves between General, Access and API keys. In a frame narrower than 1208px the main rail folds to icons, so the page keeps its 720px column."
      >
        <SettingsPreview initialPage="general" label="General" />
      </KitBlock>
      <PicksInUse
        keys={[
          "navigation",
          "page-header",
          "section",
          "setting-row",
          "switch",
          "segmented-control",
          "select",
          "form-dialog",
          "destructive-confirm",
        ]}
      />
    </KitSection>
  );
}
