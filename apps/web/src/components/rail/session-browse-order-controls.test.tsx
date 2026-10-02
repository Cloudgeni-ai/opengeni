import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DropdownMenu as Primitive } from "radix-ui";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { SessionBrowseOrderControls } from "./session-browse-order-controls";

describe("compact session view menu", () => {
  test.each(["activity", "project", "none", "created", "creator"] as const)(
    "renders %s with independent compact values",
    (groupBy) => {
      const markup = renderToStaticMarkup(
        <DropdownMenu open>
          <Primitive.Content forceMount>
            <SessionBrowseOrderControls
              groupBy={groupBy}
              onGroupByChange={() => {}}
              sortBy="name"
              onSortByChange={() => {}}
              status="active"
              onStatusChange={() => {}}
              showEmptyGroups
              onShowEmptyGroupsChange={() => {}}
            />
          </Primitive.Content>
        </DropdownMenu>,
      );
      expect(markup.indexOf("Status")).toBeLessThan(markup.indexOf("Group by"));
      expect(markup.indexOf("Group by")).toBeLessThan(markup.indexOf("Sort by"));
      expect(markup).toContain("Name");
      expect(markup).toContain("Show empty groups");
      expect(markup).toContain('role="menuitemcheckbox"');
      expect(markup.includes('aria-disabled="true"')).toBe(groupBy === "none");
      expect(markup).not.toContain("Sort order is fixed");
      expect(markup).not.toContain("Filter by");
    },
  );

  test("offers a Needs you status with the waiting count", () => {
    const render = (needsYouCount: number, status: "active" | "needs-you" = "active") =>
      renderToStaticMarkup(
        <DropdownMenu open>
          <Primitive.Content forceMount>
            <SessionBrowseOrderControls
              groupBy="project"
              onGroupByChange={() => {}}
              sortBy="updatedAt"
              onSortByChange={() => {}}
              status={status}
              onStatusChange={() => {}}
              needsYouCount={needsYouCount}
              showEmptyGroups={false}
              onShowEmptyGroupsChange={() => {}}
            />
          </Primitive.Content>
        </DropdownMenu>,
      );
    expect(render(0, "needs-you")).toContain("Needs you");
    expect(render(3)).not.toContain("3 waiting");
    expect(render(0)).not.toContain("waiting");
  });
});
