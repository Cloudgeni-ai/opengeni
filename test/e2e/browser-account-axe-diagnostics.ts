import type { Page } from "playwright";

/** Observe the menu readiness/axe boundary without retaining page content or authority. */
export async function withAccountMenuAxeDiagnostics<T>(
  page: Page,
  inspect: () => Promise<T>,
): Promise<T> {
  const observation = await page.evaluateHandle(() => {
    const selector = '[data-slot="dropdown-menu-content"]';
    const initialPath = location.pathname;
    const startedAt = performance.now();
    const samples: Array<{
      event: "start" | "mutation" | "focus" | "blur" | "stop";
      elapsedMs: number;
      menuCount: number;
      openMenuCount: number;
      openDrawerCount: number;
      documentFocused: boolean;
      focusInsideMenu: boolean;
      pathnameChanged: boolean;
    }> = [];
    let droppedSamples = 0;
    let stopped = false;
    let previousNodes: Element[] = [];
    let previousState = "";
    const record = (event: "start" | "mutation" | "focus" | "blur" | "stop") => {
      const nodes = [...document.querySelectorAll(selector)];
      const sample = {
        event,
        elapsedMs: Math.round(performance.now() - startedAt),
        menuCount: nodes.length,
        openMenuCount: nodes.filter((node) => node.getAttribute("data-state") === "open").length,
        openDrawerCount: document.querySelectorAll('[data-slot="sheet-content"][data-state="open"]')
          .length,
        documentFocused: document.hasFocus(),
        focusInsideMenu: nodes.some((node) => node.contains(document.activeElement)),
        pathnameChanged: location.pathname !== initialPath,
      };
      const state = JSON.stringify({ ...sample, event: undefined, elapsedMs: undefined });
      const sameNodes =
        nodes.length === previousNodes.length &&
        nodes.every((node, index) => node === previousNodes[index]);
      if (event === "mutation" && sameNodes && state === previousState) return;
      previousNodes = nodes;
      previousState = state;
      if (samples.length < 24) samples.push(sample);
      else {
        droppedSamples += 1;
        if (event === "stop") samples[23] = sample;
      }
    };
    const onFocus = () => record("focus");
    const onBlur = () => record("blur");
    const observer = new MutationObserver(() => record("mutation"));
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-state"],
    });
    window.addEventListener("focus", onFocus, true);
    window.addEventListener("blur", onBlur, true);
    record("start");
    return {
      stop() {
        if (stopped) return { samples, droppedSamples };
        stopped = true;
        record("stop");
        observer.disconnect();
        window.removeEventListener("focus", onFocus, true);
        window.removeEventListener("blur", onBlur, true);
        return { samples, droppedSamples };
      },
    };
  });
  try {
    return await inspect();
  } catch (cause) {
    // A document replacement may destroy the observation handle. Do not let
    // diagnostic collection replace the original accessibility failure.
    const evidence = await observation
      .evaluate((value) => value.stop())
      .catch(() => ({
        observationUnavailable: true,
      }));
    throw new Error(`account menu axe scope evidence: ${JSON.stringify(evidence)}`, { cause });
  } finally {
    await observation.evaluate((value) => value.stop()).catch(() => undefined);
    await observation.dispose().catch(() => undefined);
  }
}
