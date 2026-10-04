import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ModelMark, modelHasMark } from "../src/components/model-mark";
import { registerDom } from "./render-hook";

registerDom();
let mounted: { root: Root; container: HTMLElement } | null = null;
afterEach(async () => {
  if (!mounted) return;
  const current = mounted;
  mounted = null;
  await act(async () => current.root.unmount());
  current.container.remove();
});

test("catalog logo failures fall back and a new URL renders without remounting", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted = { root, container };
  const render = async (logoUrl: string) =>
    act(async () =>
      root.render(
        <ModelMark model={{ id: "example/model", logoUrl }} aria-label="Example model" />,
      ),
    );
  await render("https://cdn.example.test/first.svg");
  let image = container.querySelector("img")!;
  expect(image.getAttribute("src")).toBe("https://cdn.example.test/first.svg");
  expect(image.getAttribute("referrerpolicy")).toBe("no-referrer");
  expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("Example model");
  await act(async () => {
    image.dispatchEvent(new Event("error"));
  });
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("svg")).not.toBeNull();
  await render("https://cdn.example.test/second.svg");
  expect(container.querySelector("img")?.getAttribute("src")).toBe(
    "https://cdn.example.test/second.svg",
  );
  await render("javascript:alert(1)");
  expect(container.querySelector("img")).toBeNull();
  expect(modelHasMark({ id: "example/model", logoUrl: "https://cdn.example.test/model.svg" })).toBe(
    true,
  );
  expect(modelHasMark({ id: "example/model", logoUrl: "http://cdn.example.test/model.svg" })).toBe(
    false,
  );
});
