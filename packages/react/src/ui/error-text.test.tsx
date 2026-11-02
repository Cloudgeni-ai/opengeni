import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ErrorMessage } from "./error-message";
import { ErrorText } from "./error-text";
import { Field } from "./field";

const REFERENCE = "163bc913-264d-4d38-a0b5-2e4e955eecdb";
const UNEXPECTED = `Opengeni couldn't finish the request. Try again in a moment. Reference: ${REFERENCE}.`;

test("inline error text offers an unexpected failure's reference as Copy details", () => {
  const html = renderToStaticMarkup(<ErrorText>{UNEXPECTED}</ErrorText>);
  expect(html).toContain("Opengeni couldn&#x27;t finish the request. Try again in a moment.");
  expect(html).toContain("Copy details");
  expect(html).not.toContain(REFERENCE);
});

test("inline error text shows an expected refusal without status or reference", () => {
  const html = renderToStaticMarkup(
    <ErrorText>{`API 409: Name is already in use. Reference: ${REFERENCE}.`}</ErrorText>,
  );
  expect(html).toBe("Name is already in use.");
  expect(renderToStaticMarkup(<ErrorText>Pick a workspace first.</ErrorText>)).toBe(
    "Pick a workspace first.",
  );
});

test("a field's error uses the same rendering", () => {
  const html = renderToStaticMarkup(
    <Field label="Name" error={UNEXPECTED}>
      <input />
    </Field>,
  );
  expect(html).toContain("Copy details");
  expect(html).not.toContain(`Reference: ${REFERENCE}`);
});

test("ErrorMessage moves a trailing reference into Technical details", () => {
  const html = renderToStaticMarkup(
    <ErrorMessage title="Couldn't load skills." defaultDetailsOpen>
      {UNEXPECTED}
    </ErrorMessage>,
  );
  expect(html).toContain("Technical details");
  expect(html).toContain(REFERENCE);
  expect(html).not.toContain(`Reference: ${REFERENCE}.`);
  // An explicit reference still wins.
  const explicit = renderToStaticMarkup(
    <ErrorMessage title="Couldn't load." reference="req-1" defaultDetailsOpen>
      {UNEXPECTED}
    </ErrorMessage>,
  );
  expect(explicit).toContain("req-1");
  expect(explicit).not.toContain(REFERENCE);
});
