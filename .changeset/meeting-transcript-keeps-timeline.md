---
"@opengeni/worker-bundle": patch
---

A meeting transcript's times now match the recording all the way to the end. A desktop's
computer-audio track can leave small holes in its timestamps, and the worker used to close
them up when converting audio for a model and when placing words and speakers, so the
transcript ran ahead of playback: about 33 seconds by the end of an 8-minute meeting, with
the last words timed before the audio ended. The worker now fills each hole with silence,
so words, speaker turns and pieces of long tracks stay on the recording's own timeline.
