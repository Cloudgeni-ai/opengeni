import { describe, expect, test } from "bun:test";

async function source(path: string): Promise<string> {
  return Bun.file(`${import.meta.dir}/${path}`).text();
}

describe("Meeting recorder mount", () => {
  // The workspace shell unmounts while the person switches workspace. A
  // recorder mounted inside it stopped the recording then (a desktop meeting
  // ended after 8 minutes when its owner opened another workspace).
  test("lives in the root route, above the workspace shell and the waiting panels", async () => {
    const root = await source("context.tsx");
    expect(root).toMatch(
      /<ConsoleMeetingRecorderProvider[^>]*>\s*\{surface\}\s*<\/ConsoleMeetingRecorderProvider>/,
    );
    expect(root).toMatch(/recordSurface\(applicationSurface\)/);
    // With browser accounts it sits above the accounts loading gate, keyed on
    // the accounts actor (#6248).
    expect(root).toMatch(
      /recordSurface\(\s*<BrowserAccountsLoadingGate>\s*\{applicationSurface\}\s*<\/BrowserAccountsLoadingGate>,\s*browserActorGeneration,?\s*\)/,
    );
    expect(root).toMatch(/onActorTransition=\{handleRecordedBrowserActorTransition\}/);
    // Above sign-in, it is told who is signed in, so sign-out ends a recording.
    expect(root).toMatch(/<ConsoleMeetingRecorderProvider[^>]*\sperson=\{recorderPerson\}/);
    const shell = await source("routes/workspace.tsx");
    expect(shell).not.toContain("ConsoleMeetingRecorderProvider");
  });

  test("loads only the light recorder entry at startup", async () => {
    const provider = await source("components/meetings/recorder-provider.tsx");
    expect(provider).toContain('from "@opengeni/react/meetings-recorder"');
    expect(provider).not.toContain('from "@opengeni/react/meetings"');
  });
});
