import { takeSnapshot } from "@uiverify/vitest";
import { Plus } from "lucide-react";
import { expect, test } from "vitest";
import { render } from "vitest-browser-react";

import { Button } from "@/components/ui/button";
import "@/styles.css";

const variants = ["default", "secondary", "outline", "ghost", "link", "destructive"] as const;
const sizes = ["xs", "sm", "default", "lg"] as const;
const iconSizes = ["icon-xs", "icon-sm", "icon", "icon-lg"] as const;

// One matrix per theme: related variants share a baseline instead of billing
// every size/state separately. Fixtures are static and require no backend.
for (const theme of ["light", "dark"] as const) {
  test(`Button / variants, sizes and disabled states / ${theme}`, async () => {
    const screen = await render(
      <main data-og-theme={theme} className={`${theme} min-h-screen bg-bg p-8 font-sans text-fg`}>
        <h1 className="mb-6 text-xl font-semibold">Buttons — {theme}</h1>
        <table className="w-full border-separate border-spacing-3 text-left text-sm">
          <thead>
            <tr>
              <th scope="col">Variant</th>
              {sizes.map((size) => (
                <th scope="col" key={size}>
                  {size}
                </th>
              ))}
              <th scope="col">Disabled</th>
            </tr>
          </thead>
          <tbody>
            {variants.map((variant) => (
              <tr key={variant}>
                <th scope="row" className="font-medium">
                  {variant}
                </th>
                {sizes.map((size) => (
                  <td key={size}>
                    <Button variant={variant} size={size}>
                      New session
                    </Button>
                  </td>
                ))}
                <td>
                  <Button variant={variant} disabled>
                    New session
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <h2 className="mb-4 mt-6 font-semibold">Icon sizes</h2>
        <div className="flex items-center gap-6">
          {iconSizes.map((size) => (
            <div key={size} className="flex items-center gap-3">
              <span className="text-sm text-fg-muted">{size}</span>
              <Button size={size} aria-label={`New session (${size})`}>
                <Plus />
              </Button>
            </div>
          ))}
        </div>
      </main>,
    );

    await expect.element(screen.getByRole("heading", { name: `Buttons — ${theme}` })).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "New session (icon-lg)", exact: true }))
      .toBeVisible();
    // The quickstart's pinned SDK archives completed resource requests. Wait for
    // the local font bytes so dashboard replay does not fall back to system fonts.
    await document.fonts.ready;
    // Capture the committed render before the React helper's automatic cleanup.
    await takeSnapshot();
  });
}
