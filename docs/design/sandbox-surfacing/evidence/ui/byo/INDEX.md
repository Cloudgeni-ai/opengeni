# M9 — Bring-your-own-compute UI screenshot evidence (V12)

49 PNGs across **5 passes**, rendering every state-matrix cell of the Machines
dashboard + enrollment flow + dock parity. Captured headless with **nix-Chromium**
(`nix build nixpkgs#chromium` → `result/bin/chromium`, version 138.0.7204.49) via
Playwright `executablePath` (per the `playwright-on-nixos` memory — the downloaded
Chromium won't run on NixOS). Each capture also ran `getComputedStyle` on key
elements (per `render-ui-bugs-in-browser`): **`style-probe.json` shows 0/49 with
unresolved tokens** — every color/border/bar width resolved to a real
oklch/oklab/rgb value, proving the OKLCH token theme wired up (dark AND light).

Regenerate: `cd packages/react && bun run demo --port 3107` then
`PORT=3107 node docs/design/sandbox-surfacing/evidence/ui/byo/shoot-machines.mjs`.
Seed data: `packages/react/demo/machines-fixtures.ts` (a workspace with a Modal
box + a selfhosted machine so a SWAP is exercisable, one machine in EACH state,
idle-vs-contended metrics — no live machine needed).

The state-matrix second axis (desktop **1280** / tablet **834** / mobile **390**)
is the `.desktop` / `.tablet` / `.mobile` suffix on each file.

## Pass 1 — IA / flow (enrollment device-flow → Machines list → attach/swap)

| File | Shows |
|---|---|
| `1-flow/01-device-flow.{desktop,tablet,mobile}` | The in-session device-flow panel: install one-liner, the big `userCode`, the "Open approval page" CTA, the verification URI + expiry, a "Waiting for approval" pill. |
| `1-flow/02-machines-list.{desktop,tablet,mobile}` | The populated Machines dashboard (the list step) — all 9 machines with pills/badges/metrics. |
| `1-flow/03-attach-swap.desktop` | The swap transition: before (Modal active) → after (selfhosted active), the active-edge + "Routing here" moving to the machine. |

## Pass 2 — layout (dock parity: Files/Terminal/Desktop identical, selfhosted vs Modal)

| File | Shows |
|---|---|
| `2-layout/04-dock-parity.{desktop,tablet,mobile}` | Side-by-side: a Modal box and a selfhosted machine render the SAME Files/Terminal/Desktop tabs below the dock bar; the selfhosted side adds the shared disclosure. The only backend-aware chrome is the bar — the surfaces are identical. |
| `2-layout/05-modal-card.desktop` | The synthetic Modal session-group card (`isSessionGroup`), the swap source. |

## Pass 3 — state coverage (all 8 states)

| File | State |
|---|---|
| `3-states/06-state-empty.*` | **empty** — no machines, the enroll CTA. |
| `3-states/07-state-enrolling.*` | **enrolling** — in device-flow, "Enrolling" badge + reconnecting pill. |
| `3-states/08-state-online.*` | **online** — idle metrics, Attach affordance. |
| `3-states/09-state-reconnecting.*` | **reconnecting** — the breathing resiliency-blip pill. |
| `3-states/10-state-offline.*` | **offline** — "No metrics yet", "Unavailable", not attachable. |
| `3-states/11-state-permission-denied.*` | **permission-denied** (`consent_required`) — the "Consent required" badge. |
| `3-states/12-state-desktop-unavailable.*` | **desktop-unavailable** (`display_unavailable`, headless) — the "No display" badge + headless marker. |
| `3-states/13-state-shared-in-use.*` | **shared-in-use** — the "Shared · 2" chip + the in-card shared disclosure. |
| `3-states/14-state-contended-metrics.desktop` | A contended machine — CPU 96% (hot/red bars), GPU + run-queue surfaced (idle-vs-contended seed). |

## Pass 4 — responsive / density (desktop / tablet / mobile)

| File | Shows |
|---|---|
| `4-responsive/15-dashboard.{desktop,tablet,mobile}` | The full 9-machine grid reflowing 3-col → 2-col → 1-col; every cell stays legible at 390px. |

## Pass 5 — polish (status pill, swap, shared disclosure, consent screens)

| File | Shows |
|---|---|
| `5-polish/16-status-pills.desktop` | Every connection pill + state badge in one strip (online/reconnecting/offline + the three reason badges + a Shared chip). |
| `5-polish/17-shared-disclosure.{desktop,mobile}` | The "shared — another session is on this machine" disclosure block. |
| `5-polish/18-consent-whole-machine.{desktop,tablet,mobile}` | The LOUD whole-machine consent approve page: danger framing, the three capability disclosures, the optional screen-control toggle, "Grant full access". |
| `5-polish/19-consent-headless.desktop` | The consent page for a no-display machine — the screen-control toggle is hidden, replaced by a "files/terminal/git only" note. |
| `5-polish/20-consent-approved.desktop` | The approved result panel. |
| `5-polish/21-consent-denied.desktop` | The denied result panel. |
| `5-polish/22-dashboard-light.desktop` | The dashboard in the LIGHT theme — proves the dark↔light token flip. |
