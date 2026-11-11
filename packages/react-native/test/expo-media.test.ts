import { describe, expect, mock, test } from "bun:test";

// The Expo adapter's photo, video and upload paths against stand-ins for the
// native modules: what it asks the system picker for, how it describes what
// comes back, and how it hands a file on disk to the native uploader.
const pickerCalls: Array<{ kind: "library" | "camera"; options: Record<string, unknown> }> = [];
let pickerAssets: Array<Record<string, unknown>> = [];
let cameraGranted = true;

mock.module("react-native", () => ({
  AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
  Platform: { OS: "ios" },
}));
mock.module("expo-modules-core", () => ({ requireOptionalNativeModule: () => null }));
mock.module("expo-crypto", () => ({
  randomUUID: () => "picked-id",
  digest: async () => new ArrayBuffer(32),
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
}));
mock.module("expo-document-picker", () => ({ getDocumentAsync: async () => ({ canceled: true }) }));
mock.module("expo/fetch", () => ({ fetch: async () => new Response(null) }));
mock.module("expo-audio", () => ({
  RecordingPresets: { HIGH_QUALITY: {} },
  requestRecordingPermissionsAsync: async () => ({ granted: true }),
  setAudioModeAsync: async () => undefined,
  useAudioRecorder: () => ({}),
}));
mock.module("expo-image-picker", () => ({
  launchImageLibraryAsync: async (options: Record<string, unknown>) => {
    pickerCalls.push({ kind: "library", options });
    return { canceled: false, assets: pickerAssets };
  },
  launchCameraAsync: async (options: Record<string, unknown>) => {
    pickerCalls.push({ kind: "camera", options });
    return { canceled: false, assets: pickerAssets };
  },
  requestCameraPermissionsAsync: async () => ({ granted: cameraGranted, canAskAgain: false }),
}));

type UploadCall = { url: string; options: Record<string, unknown> };
const uploads: UploadCall[] = [];
class FakeFile {
  static sizes = new Map<string, number>();
  constructor(readonly uri: string) {}
  get exists() {
    return FakeFile.sizes.has(this.uri);
  }
  get size() {
    return FakeFile.sizes.get(this.uri) ?? 0;
  }
  async upload(url: string, options: Record<string, unknown>) {
    uploads.push({ url, options });
    const onProgress = options.onProgress as (progress: {
      bytesSent: number;
      totalBytes: number;
    }) => void;
    onProgress({ bytesSent: 0, totalBytes: 0 });
    onProgress({ bytesSent: this.size / 2, totalBytes: this.size });
    onProgress({ bytesSent: this.size, totalBytes: this.size });
    return { status: 200, body: "", headers: {} };
  }
}
mock.module("expo-file-system", () => ({
  File: FakeFile,
  Directory: Object,
  Paths: {},
  UploadType: { BINARY_CONTENT: 0, MULTIPART: 1 },
}));

const { expoFileAdapter, pickedMediaFile } = await import("../src/expo");

const video = {
  uri: "file:///cache/ImagePicker/A1.MOV",
  type: "video",
  mimeType: "video/quicktime",
  fileName: "IMG_0042.MOV",
  fileSize: 734_003_200,
  duration: 42_500,
};
const photo = {
  uri: "file:///cache/ImagePicker/B2.jpg",
  type: "image",
  mimeType: "image/jpeg",
  fileName: "IMG_0043.JPG",
  fileSize: 2_000_000,
};

describe("Expo photo library and camera", () => {
  test("the library offers photos and videos and keeps a video's original file", async () => {
    pickerAssets = [video, photo];
    const picked = await expoFileAdapter.pickImages();

    expect(pickerCalls.at(-1)).toEqual({
      kind: "library",
      options: { allowsMultipleSelection: true, mediaTypes: ["images", "videos"], quality: 1 },
    });
    expect(picked).toEqual([
      {
        id: "picked-id",
        uri: video.uri,
        name: "IMG_0042.MOV",
        contentType: "video/quicktime",
        sizeBytes: 734_003_200,
        kind: "video",
        durationSeconds: 42.5,
      },
      {
        id: "picked-id",
        uri: photo.uri,
        name: "IMG_0043.JPG",
        contentType: "image/jpeg",
        sizeBytes: 2_000_000,
        kind: "image",
        previewUri: photo.uri,
      },
    ]);
  });

  test("the camera can record a video as well as take a photo", async () => {
    pickerAssets = [{ ...video, fileName: null }];
    const [recorded] = await expoFileAdapter.takePhoto!();

    expect(pickerCalls.at(-1)).toEqual({
      kind: "camera",
      options: { mediaTypes: ["images", "videos"], quality: 0.9 },
    });
    expect(recorded).toMatchObject({ kind: "video", name: "A1.MOV" });
  });

  test("a camera turned off in Settings says how to turn it on", async () => {
    cameraGranted = false;
    try {
      await expect(expoFileAdapter.takePhoto!()).rejects.toThrow(
        "Camera access is off for this app. Turn it on in Settings to take photos and videos.",
      );
    } finally {
      cameraGranted = true;
    }
  });

  test("a video the picker could not type is typed from its extension", () => {
    const base = { uri: "file:///a/clip.mp4", type: "video" as const, fileName: null };
    expect(pickedMediaFile(base, "1").contentType).toBe("video/mp4");
    expect(pickedMediaFile({ ...base, uri: "file:///a/clip.MOV" }, "2").contentType).toBe(
      "video/quicktime",
    );
    expect(pickedMediaFile({ ...base, uri: "file:///a/clip" }, "3").contentType).toBe(
      "video/quicktime",
    );
    expect(pickedMediaFile({ ...base, duration: 0 }, "4").durationSeconds).toBeUndefined();
    expect(pickedMediaFile({ uri: "file:///a/photo", type: "image" }, "5")).toMatchObject({
      contentType: "image/jpeg",
      kind: "image",
      previewUri: "file:///a/photo",
    });
  });
});

describe("Expo streamed upload", () => {
  test("PUTs the file from disk with exactly the signed headers and reports progress", async () => {
    FakeFile.sizes.set(video.uri, 734_003_200);
    const fractions: number[] = [];
    const source = expoFileAdapter.uploadSource!(
      {
        id: "v",
        uri: video.uri,
        name: "IMG_0042.MOV",
        contentType: "video/quicktime",
        sizeBytes: null,
        kind: "video",
      },
      (fraction) => fractions.push(fraction),
    );
    expect(source.sizeBytes).toBe(734_003_200);

    const controller = new AbortController();
    const headers = { "content-type": "video/quicktime", "x-amz-meta-sha256": "x" };
    const sent = await source.send({
      url: "https://storage.example.test/put",
      headers,
      sizeBytes: 734_003_200,
      signal: controller.signal,
    });

    expect(sent).toEqual({ status: 200 });
    expect(uploads.at(-1)?.url).toBe("https://storage.example.test/put");
    expect(uploads.at(-1)?.options).toMatchObject({
      httpMethod: "PUT",
      uploadType: 0,
      headers,
      signal: controller.signal,
    });
    // No progress before the total is known; then the fraction sent.
    expect(fractions).toEqual([0.5, 1]);
  });

  test("a file no longer on the device fails with a plain way forward", () => {
    expect(() =>
      expoFileAdapter.uploadSource!(
        {
          id: "gone",
          uri: "file:///gone.mov",
          name: "gone.mov",
          contentType: "video/quicktime",
          sizeBytes: 1,
          kind: "video",
        },
        () => undefined,
      ),
    ).toThrow("This file is no longer on the device. Attach it again.");
  });
});
