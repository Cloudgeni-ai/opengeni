import { describe, expect, test } from "bun:test";
import {
  audioImportMimeType,
  importedAudioTitle,
  isSharedAudioUrl,
  sharedAudioRedirect,
} from "../src/meetings/audio-files";

describe("audio import", () => {
  test("takes the kinds of audio recordings take, by stated type or name", () => {
    expect(audioImportMimeType("Call with Ola.m4a")).toBe("audio/mp4");
    expect(audioImportMimeType("memo", "audio/x-m4a")).toBe("audio/mp4");
    expect(audioImportMimeType("clip.webm", "")).toBe("audio/webm");
    expect(audioImportMimeType("voice.opus")).toBe("audio/ogg");
    expect(audioImportMimeType("song.mp3", "audio/mpeg")).toBeNull();
    expect(audioImportMimeType("take.wav")).toBeNull();
    expect(audioImportMimeType("no-extension")).toBeNull();
  });

  test("names the meeting from a file name that says something", () => {
    expect(importedAudioTitle("Call with Ola Nordmann.m4a")).toBe(
      "Call with Ola Nordmann",
    );
    expect(importedAudioTitle("Kundemøte_Tripletex.m4a")).toBe(
      "Kundemøte Tripletex",
    );
    expect(importedAudioTitle("New Recording 12.m4a")).toBeNull();
    expect(
      importedAudioTitle("3F2504E0-4F89-11D3-9A0C-0305E82C3301.m4a"),
    ).toBeNull();
    expect(importedAudioTitle("20261031 140500.m4a")).toBeNull();
  });

  test("knows a shared file from one of the app's own links", () => {
    const inbox =
      "file:///private/var/mobile/Containers/Data/Application/X/Documents/Inbox/Call%20with%20Ola.m4a";
    expect(isSharedAudioUrl(inbox)).toBe(true);
    expect(
      isSharedAudioUrl(
        "content://com.android.providers.media.documents/document/audio%3A12",
      ),
    ).toBe(true);
    expect(isSharedAudioUrl("file:///tmp/notes.pdf")).toBe(false);
    expect(
      isSharedAudioUrl("opengeni://open?url=https%3A%2F%2Fexample.com"),
    ).toBe(false);
    expect(sharedAudioRedirect(inbox)).toBe("/meetings");
    expect(sharedAudioRedirect("/session/abc")).toBeNull();
  });
});
