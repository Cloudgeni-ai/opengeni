import { KitBlock, KitSection } from "../kit";
import { PicksInUse, SettingsPreview } from "../pages/settings/preview";

export default function PageAccessSection() {
  return (
    <KitSection sectionKey="page-access">
      <KitBlock
        title="Page"
        description="Access inside the app, built from your picks. Change a role, remove someone and undo it, review Jonas's Slack request, or add people from Acme Robotics on a page of its own. With role-as-text rows, a person opens as their own page. In a frame narrower than 1208px the main rail folds to icons, so the page keeps its 720px column."
      >
        <SettingsPreview initialPage="access" label="Access" />
      </KitBlock>
      <PicksInUse
        keys={[
          "navigation",
          "page-header",
          "section",
          "access-list",
          "list-row",
          "form-dialog",
          "detail-sheet",
          "status-badge",
        ]}
      />
    </KitSection>
  );
}
