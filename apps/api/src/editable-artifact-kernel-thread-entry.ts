import { serveEditableArtifactKernelThread } from "./editable-artifact-kernel-thread";
import { loadVerifiedNativeArtifactRuntime } from "./editable-artifact-native-kernel";

// Worker-thread entrypoint: the same manifest-pinned, byte-verified runtime as
// the API process, so kernel identity and results are unchanged.
serveEditableArtifactKernelThread(loadVerifiedNativeArtifactRuntime);
