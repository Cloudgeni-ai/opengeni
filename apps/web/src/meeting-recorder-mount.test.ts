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
    expect(root).toContain("<ConsoleMeetingRecorderProvider");
    expect(root).toContain("{applicationSurface}\n    </ConsoleMeetingRecorderProvider>");
    expect(root).toContain(
      "<BrowserAccountsLoadingGate>{recordedSurface}</BrowserAccountsLoadingGate>",
    );
    const shell = await source("routes/workspace.tsx");
    expect(shell).not.toContain("ConsoleMeetingRecorderProvider");
  });

  test("loads only the light recorder entry at startup", async () => {
    const provider = await source("components/meetings/recorder-provider.tsx");
    expect(provider).toContain('from "@opengeni/react/meetings-recorder"');
    expect(provider).not.toContain('from "@opengeni/react/meetings"');
  });
});
