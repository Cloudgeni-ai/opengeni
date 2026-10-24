---
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/config": patch
"@opengeni/worker-bundle": patch
"@opengeni/api-router": patch
---

Recordings can tell speakers apart without the transcription model's help: the worker runs its own CPU diarizer (pyannote segmentation and CAM++ voice vectors on ONNX Runtime), chosen with `diarizer: "ours"` per request or in workspace recording settings, and used automatically when the model has no diarization.
