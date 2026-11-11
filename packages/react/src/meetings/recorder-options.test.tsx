import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// The DOM comes first: menus portal only where a document existed at load.
GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { RecorderOptions } = await import("./recorder-panel");

afterAll(() => {
  GlobalRegistrator.unregister();
});

async function render(node: React.ReactNode) {
  document.body.replaceChildren();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  return { unmount: async () => await act(async () => root.unmount()) };
}

test("the options menu picks the language, and says what the live transcript costs", async () => {
  const picked: string[] = [];
  const view = await render(
    <RecorderOptions
      language="no"
      onLanguageChange={(language) => picked.push(language)}
      live={{ on: true, usdPerHour: 0.39, onChange: () => {} }}
      disabled={false}
      defaultOpen
    />,
  );
  try {
    const trigger = document.querySelector<HTMLButtonElement>("button[aria-label]");
    expect(trigger?.getAttribute("aria-label")).toBe("Recording options, Norwegian");
    expect(trigger?.textContent).toBe("Norwegian");
    const languages = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    expect(languages[0]?.textContent).toBe("Detect language");
    const checked = languages.find((item) => item.getAttribute("aria-checked") === "true");
    expect(checked?.textContent).toBe("Norwegian");
    const live = document.querySelector<HTMLElement>('[role="menuitemcheckbox"]');
    expect(live?.textContent).toBe("Live transcript");
    expect(live?.getAttribute("aria-checked")).toBe("true");
    expect(document.body.textContent).toContain(
      "Shows rough text while you record. About $0.39 per hour.",
    );
    await act(async () => languages[0]!.click());
    expect(picked).toEqual(["auto"]);
  } finally {
    await view.unmount();
  }
});

test("without a live model the menu only picks the language", async () => {
  const view = await render(
    <RecorderOptions
      language="auto"
      onLanguageChange={() => {}}
      live={null}
      disabled={false}
      defaultOpen
    />,
  );
  try {
    expect(document.querySelector('[role="menuitemcheckbox"]')).toBeNull();
    expect(document.body.textContent).not.toContain("per hour");
    expect(document.querySelector("button[aria-label]")?.getAttribute("aria-label")).toBe(
      "Recording options, Detect language",
    );
  } finally {
    await view.unmount();
  }
});

test("a workspace in Bokmål sees it once, in Norwegian's place", async () => {
  const { meetingLanguageOptions } = await import("./meeting-languages");
  const values = meetingLanguageOptions("nb").map((option) => option.value);
  expect(values.slice(0, 3)).toEqual(["auto", "en", "nb"]);
  expect(values).not.toContain("no");
  expect(meetingLanguageOptions("no").map((option) => option.value)).not.toContain("nb");
});
