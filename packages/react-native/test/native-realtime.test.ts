import { describe, expect, test } from "bun:test";
import {
  createMemoryRealtimeOwnerStorage,
  createNativeRealtimeControllerFactory,
  createNativeRemoteAudio,
} from "../src/realtime/native-realtime";

function remoteStream() {
  const tracks = [
    { kind: "audio", enabled: true },
    { kind: "audio", enabled: true },
  ];
  return { tracks, getAudioTracks: () => tracks };
}

describe("native remote audio", () => {
  test("plays by enabling remote tracks and mutes by disabling them", async () => {
    const audio = createNativeRemoteAudio();
    const stream = remoteStream();
    audio.srcObject = stream as unknown as MediaStream;
    expect(stream.tracks.every((track) => !track.enabled)).toBe(true);
    await audio.play();
    expect(stream.tracks.every((track) => track.enabled)).toBe(true);
    audio.muted = true;
    expect(stream.tracks.every((track) => !track.enabled)).toBe(true);
    audio.muted = false;
    expect(stream.tracks.every((track) => track.enabled)).toBe(true);
    audio.pause();
    expect(stream.tracks.every((track) => !track.enabled)).toBe(true);
  });

  test("detaching the stream leaves it silent and paused", async () => {
    const audio = createNativeRemoteAudio();
    audio.srcObject = remoteStream() as unknown as MediaStream;
    await audio.play();
    audio.srcObject = null;
    expect(audio.srcObject).toBeNull();
    expect(audio.paused).toBe(true);
  });
});

describe("native realtime controller factory", () => {
  test("owner storage behaves like session storage", () => {
    const storage = createMemoryRealtimeOwnerStorage();
    expect(storage.getItem("owner")).toBeNull();
    storage.setItem("owner", "proof");
    expect(storage.getItem("owner")).toBe("proof");
    storage.removeItem("owner");
    expect(storage.getItem("owner")).toBeNull();
  });

  test("builds the shared controller without touching media until start", () => {
    let peerConnections = 0;
    let microphones = 0;
    const factory = createNativeRealtimeControllerFactory({
      createPeerConnection: () => {
        peerConnections += 1;
        throw new Error("not in this test");
      },
      getUserMedia: async () => {
        microphones += 1;
        throw new Error("not in this test");
      },
    });
    const controller = factory({
      client: {} as never,
      workspaceId: "workspace",
      sessionId: "session",
      model: "gpt-live-1-boulder-alpha",
    });
    expect(controller.snapshot().status).toBe("idle");
    expect(peerConnections).toBe(0);
    expect(microphones).toBe(0);
    controller.close();
  });
});
