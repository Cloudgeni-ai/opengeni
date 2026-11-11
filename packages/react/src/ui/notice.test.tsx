import { afterAll, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

// Model the production chunk cycle: Notice evaluates before its icon imports
// finish initializing, then the live exports become available before render.
mock.module("lucide-react", () => ({
  CircleAlertIcon: undefined,
  CircleCheckIcon: undefined,
  InfoIcon: undefined,
  TriangleAlertIcon: undefined,
}));
const { Notice } = await import("./notice");
mock.module("lucide-react", () => ({
  CircleAlertIcon: () => <svg data-icon="waiting" />,
  CircleCheckIcon: () => <svg data-icon="success" />,
  InfoIcon: () => <svg data-icon="info" />,
  TriangleAlertIcon: () => <svg data-icon="failed" />,
}));
afterAll(() => mock.restore());

test("all five tones resolve live icons after late module initialization", () => {
  for (const tone of ["muted", "info", "success", "waiting", "failed"] as const) {
    const html = renderToStaticMarkup(
      <Notice tone={tone} title={`${tone} title`}>
        Body
      </Notice>,
    );
    expect(html).toContain(`data-icon="${tone === "muted" ? "info" : tone}"`);
    expect(html).toContain(`${tone} title`);
    expect(html).toContain("Body");
  }
});

test("default tone, explicit icon overrides and icon suppression remain unchanged", () => {
  expect(renderToStaticMarkup(<Notice>Default</Notice>)).toContain('data-icon="info"');
  expect(
    renderToStaticMarkup(
      <Notice tone="success" icon={null}>
        Hidden
      </Notice>,
    ),
  ).not.toContain("<svg");
  const override = renderToStaticMarkup(
    <Notice
      tone="failed"
      icon={<span>Custom</span>}
      action={<button>Retry</button>}
      className="custom-notice"
    >
      Body
    </Notice>,
  );
  expect(override).toContain("Custom");
  expect(override).not.toContain("<svg");
  expect(override).toContain("Retry");
  expect(override).toContain("custom-notice");
});
