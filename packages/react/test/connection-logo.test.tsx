import { expect, test } from "bun:test";
import { BoxesIcon } from "lucide-react";
import { ConnectionLogo } from "../src/connection-logo";
import { actRun, registerDom, renderComponent } from "./render-hook";

registerDom();

test("pending logos show a neutral placeholder rather than temporary initials", async () => {
  const rendered = await renderComponent(<ConnectionLogo src={null} name="Linear" loading />);
  try {
    const logo = rendered.container.querySelector<HTMLElement>(".og-connection-logo")!;
    expect(logo.textContent).toBe("");
    expect(logo.querySelector(".og-connection-skeleton-mark")).not.toBeNull();
    await rendered.rerender(<ConnectionLogo src={null} name="Linear" loading={false} />);
    expect(logo.textContent).toBe("L");
  } finally {
    await rendered.unmount();
  }
});

test("connection logos preserve initials when no custom fallback is supplied", async () => {
  const rendered = await renderComponent(<ConnectionLogo src={null} name="Google Drive" />);
  try {
    const logo = rendered.container.querySelector<HTMLElement>(".og-connection-logo")!;
    expect(logo.textContent).toBe("GD");
    expect(logo.getAttribute("aria-hidden")).toBe("true");
    expect(logo.style.width).toBe("40px");
    await rendered.rerender(
      <ConnectionLogo src="https://example.com/logo.svg" name="Google Drive" />,
    );
    await actRun(() => rendered.container.querySelector("img")!.dispatchEvent(new Event("error")));
    expect(logo.textContent).toBe("GD");
    expect(logo.querySelector("img")).toBeNull();
  } finally {
    await rendered.unmount();
  }
});

test("custom fallback covers absent and failed logos while a new source can load", async () => {
  const fallback = <BoxesIcon aria-hidden="true" />;
  const rendered = await renderComponent(
    <ConnectionLogo src={null} name="Research suite" fallback={fallback} size={56} />,
  );
  try {
    const logo = rendered.container.querySelector<HTMLElement>(".og-connection-logo")!;
    expect(logo.querySelector("svg")).not.toBeNull();
    expect(logo.textContent).toBe("");
    expect(logo.style.width).toBe("56px");
    await rendered.rerender(
      <ConnectionLogo
        src="https://example.com/first.svg"
        name="Research suite"
        fallback={fallback}
      />,
    );
    expect(logo.querySelector("svg")).toBeNull();
    await actRun(() => logo.querySelector("img")!.dispatchEvent(new Event("error")));
    expect(logo.querySelector("svg")).not.toBeNull();
    await rendered.rerender(
      <ConnectionLogo
        src="https://example.com/second.svg"
        name="Research suite"
        fallback={fallback}
      />,
    );
    expect(logo.querySelector("img")?.getAttribute("src")).toBe("https://example.com/second.svg");
    expect(logo.querySelector("svg")).toBeNull();
  } finally {
    await rendered.unmount();
  }
});
