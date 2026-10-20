# Browser recording

Agents record a browser flow as a video that plays in chat. Recordings are
proof of work: a flow that moved, a bug that reproduces, a feature walkthrough.
This document covers capture, storage and encoding. Editing (cuts, speed-ups,
captions, voice-over) is the agent's job afterwards with ordinary tools such as
ffmpeg; nothing for editing is bundled.

## Requirements

- An agent can start and stop a recording of a browser session and gets back a
  workspace video file it can publish, so it plays in chat, or edit.
- Capture costs close to nothing while a page is still, works the same for
  managed browsers on every placement (Linux sandboxes, macOS and Windows
  machines) and for attached Chrome, and works for background tabs without
  raising or focusing the browser.
- A timestamped action log is saved next to the video, so editing can be
  automatic: speed up waits, mark clicks, caption steps.
- No new per-platform binaries on user machines or sandboxes.

Out of scope: recording the whole computer screen, and masking secrets in
recordings.

## Measurements

Spike scripts live in `spikes/browser-recording/` (removed before merge).
Chromium 150, 1280x800, JPEG quality 70, 15-20 s per run. "Flow" changes the
page every 1.5 s, like an agent working; "animated" is a spinner that changes
every frame, the worst case.

| Platform | Method | Page | Frames | JPEG size | Browser CPU |
| --- | --- | --- | --- | --- | --- |
| Linux, headless | idle baseline | flow | - | - | 0.01 cores |
| Linux, headless | screencast | flow | 15 | 0.25 MB | 0.02 cores |
| Linux, headless | screenshot poll every 100 ms | flow | 14 kept of 143 | 0.24 MB | 0.10 cores |
| Linux, headless | screencast, every frame | animated | 1198 | 9.5 MB | 0.59 cores |
| Linux, headless | screencast, every 4th frame | animated | 300 | 2.4 MB | 0.38 cores |
| macOS, headed | screencast, 100 ms ack delay | flow | 11 | 0.15 MB | 0.02 cores |
| macOS, headed | screencast, 100 ms ack delay | animated | 382 | 2.9 MB | 0.25 cores |
| macOS, headed | screencast, 200 ms ack delay | animated | 207 | 1.6 MB | 0.20 cores |
| macOS, headed | screenshot poll every 100 ms | flow | 9 kept of 80 | 0.12 MB | 0.09 cores |

- The recorder process itself used at most 0.03 cores.
- Screencast delivered frames for a foreground tab, a background tab, and a
  window fully covered by another window (macOS occlusion), on headed Linux
  (Xvfb) and headed macOS, with focus emulation on.
- A command-latency probe on the recorded tab stayed at 1 ms with the
  screencast running, foreground and background. The old concern that a
  screencast wedges later commands on a headed background tab did not
  reproduce.
- Delaying the frame ack caps the frame rate without dropping a page's last
  state; `everyNthFrame` skips compositor frames and can miss a short-lived
  change.

Encoding the recorded frames (piped at a constant 10 fps, repeating the latest
frame):

| Encoder | Flow, 15 s: CPU / size | Animated, 16 s: CPU / size |
| --- | --- | --- |
| libx264 ultrafast, stillimage (MP4), Linux | 0.27 s / 36 KB | 0.46 s / 200 KB |
| libvpx-vp9 realtime (WebM), Linux | 0.56 s / 27 KB | 0.99 s / 55 KB |
| Playwright's bundled VP8 ffmpeg, Linux | 1.1 s / 51 KB | 4.2 s / 190 KB |
| Playwright's bundled VP8 ffmpeg, macOS | 29 s / 127 KB | 32 s / 206 KB |
| libx264 ultrafast (MP4), macOS | 0.54 s / 55 KB | 0.54 s / 175 KB |

## Design

### Capture: CDP screencast in browserd

browserd records with `Page.startScreencast` (JPEG, quality 70, at most
1280x800). Chromium sends a frame only when the page repaints, so a still page
costs nothing. The recorder caps the rate by acknowledging each frame after
100 ms, so at most about 10 frames per second reach it. It records the
session's current tab and follows the agent when it switches tabs.

The same CDP call works on every placement, because every managed browser and
attached Chrome is driven over CDP; the extension already admits the `Page`
domain. Focus emulation, which the controller already holds on every tab,
keeps a background tab painting. While recording, browserd holds the
idle-parking lease so the window is not minimized, since a minimized window
stops painting.

The live view's 100 ms screenshot poll stays as it is. Recording is a
separate subscriber because it needs every change with its timestamp, while
the live view needs only the latest frame.

### Storage while recording: spool on the browser host

Each distinct frame (same-bytes repeats dropped) is appended to a spool
directory in the browser session's private directory: one JPEG per frame and
an append-only `frames.jsonl` index of timestamp, file, width and height.
Memory stays flat regardless of length. A recording is bounded at 30 minutes
and 200 MB of frames; at the bound it stops and keeps what it has.

The action log is appended by browserd for every dispatched browser action
during the recording: time since start, action kind, tab, URL, the target's
coordinates or accessible name, and typed text as given.

### Encoding: on the server, at stop

At stop, browserd packs the spool (frames plus index) into one uncompressed
tar and uploads it straight to object storage through a scoped signed URL,
the same way retained browser downloads are exported. The API then:

1. Runs ffmpeg (already in the API and worker images) over the frames with
   their real timestamps, as variable frame rate H.264 MP4 (libx264
   ultrafast, stillimage tune, `+faststart`). Only distinct frames are
   encoded, so cost follows how much the page changed, not how long the
   recording ran.
2. Stores the MP4 and the action log as workspace files at the agent's chosen
   path (default `recordings/<time>.mp4` and `recordings/<time>.actions.json`).
3. Deletes the frame archive.

Why not encode on the browser host: that needs an ffmpeg on every Linux,
macOS and Windows machine and in every sandbox image, built, licensed and
shipped per platform. The agent release would grow by several megabytes per
platform, and the cheap minimal build available (Playwright's VP8-only
ffmpeg) costs about 2 CPU cores for the duration of the encode on macOS.
Encoding on the server needs no new binaries anywhere, produces MP4 that
plays in every browser including Safari and iOS, and costs about half a
CPU-second per 15 s of video on our side.

### Agent surface

One tool, `browser_record`, with `operation: "start" | "stop" | "status"` and
the browser session. Stop returns the video file, the action log file, the
duration and size. The agent publishes the video to show it in chat, or edits
it first. Code Mode exposes the same operations on a browser session.

The browser tool description gains one sentence saying flows can be recorded
as video proof. A bundled Skill covers recording well: start before the flow,
keep the agent's pace natural, stop, publish, and use the action log with
ffmpeg to speed up waits or cut dead time. Agents may install other editing
tools, such as Remotion, when a task needs them.

## Later

- Computer-screen recording can reuse the same spool, upload and server
  encoding, fed from the computer frame stream.
- Uploading spool chunks during long recordings, if recordings lost to a
  dying host become a problem in practice.
