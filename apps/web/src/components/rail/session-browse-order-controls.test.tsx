import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { SessionBrowseOrderControls } from "./session-browse-order-controls";

describe("session browse order controls", () => {
  test.each(["activity", "created", "creator"] as const)(
    "describes the actual %s order before secondary grouping",
    (groupBy) => {
      const markup = renderToStaticMarkup(
        <DropdownMenu open>
          <DropdownMenuPrimitive.Content forceMount>
            <SessionBrowseOrderControls groupBy={groupBy} onGroupByChange={() => {}} />
          </DropdownMenuPrimitive.Content>
        </DropdownMenu>,
      );
      expect(markup.indexOf("Sort by")).toBeLessThan(markup.indexOf("Group by"));
      expect(markup).toContain(
        `${groupBy === "created" ? "Created date" : "Last activity"} · newest first`,
      );
      expect(markup).toContain(
        groupBy === "created"
          ? "Within loaded date groups. More sessions load by activity, not creation date."
          : "Within groups. Sort order is fixed.",
      );
      expect(markup).not.toContain('role="menuitemradio"');
    },
  );

  test("keeps date and creator filters separate from ordering", async () => {
    const source = await Bun.file(new URL("./session-list.tsx", import.meta.url)).text();
    expect(source.indexOf("<SessionBrowseOrderControls")).toBeLessThan(
      source.indexOf("<DropdownMenuLabel>Filter by"),
    );
    expect(source).toContain("Date filter field");
    expect(source).toContain("setBrowseDateField(value as SessionBrowseDateField)");
    expect(source).toContain("setBrowseDateRange(value as SessionBrowseDateRange)");
    expect(source).toContain('updateBrowseCreator(value === "all" ? null : value)');
    expect(source).toContain("onSelect={clearBrowseControls}");
  });
});
