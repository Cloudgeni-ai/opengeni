# Editable artifact security

> Status: threat model and release contract. The current TypeScript reference
> implementation satisfies only the controls marked **verified** below. Open
> `SEC-*` items are release blockers for untrusted artifacts, not accepted risk.

## Scope and invariants

This covers the canonical spreadsheet, document, and presentation models; the
operation codec; Office ZIP/XML import/export; images/fonts/media; renderers;
native/WASM kernels; agent scripts; browser SDK; object storage; and live sync.

An attacker may control every byte, filename, MIME claim, ZIP entry, XML node,
relationship target, formula, style, image, font, model command, operation tail,
and collaboration message. They may retry, reconnect, race actors, and submit
valid but pathologically expensive artifacts.

The non-negotiable invariants are:

1. Parsing, calculation, layout, inspection, and rendering never execute script,
   macros, formulas as host code, shell commands, or embedded executables.
2. Artifact data never causes an implicit network request or filesystem read.
   Explicit user-authorized import/download is performed outside the kernel.
3. Work is bounded before allocation by bytes, objects, depth, fan-out, pixels,
   formula fuel, wall time, memory, and output size.
4. Unsupported or active content is rejected or retained as labeled inert
   opaque data under explicit policy. It is never activated or silently lost.
5. Generated HTML/SVG/XML/OOXML is structurally escaped and safe under the host
   CSP; filenames and relationship paths cannot escape their namespace.
6. Invalid input changes no canonical state. A batch, import, and materialization
   publishes atomically only after decode, validation, apply, and verification.
7. Authorization derives from the authenticated artifact principal, never from
   document metadata, relationship ids, actor ids, or client operation bytes.

## Trust boundaries

```text
untrusted bytes / agent commands / browser edits
                    |
        size gate + canonical request validation
                    |
       isolated no-network parser/kernel process
                    |
     canonical model + inert loss-preservation envelope
                    |
  authoritative apply ---- deterministic render/materialize
                    |
 Postgres operation truth + object-store bytes + NATS notification
```

- The facade validates types and cheap limits; it is not the security authority.
- Native and WASM kernels implement identical semantic limits and reject unknown
  schema/features. Production has no permissive TypeScript fallback.
- Production runtime installation requires one canonical complete eight-target
  release manifest. Every native asset is executed on its exact OS/CPU/libc
  before its canonical receipt is accepted; aggregation rejects mixed build
  identities, missing targets, altered package metadata, or altered bytes.
- The local current-host development bundle is a separate manifest mode. Its
  loader rejects production, mixed production/development configuration,
  noncanonical receipts, symlink escapes, and post-manifest tampering. Local
  macOS materialization is deliberately **not sandboxed**: dev-stack enables it
  only through explicit development gates with loopback PostgreSQL, object
  storage, and health listeners, and health reports `sandboxEnforced: false`.
  It is a developer convenience, never a security boundary or production mode.
- Import/render/materialization runs in a dedicated process/container with no
  network and an empty mount namespace that exposes only the verified executable,
  immutable artifact runtime, and required system loader libraries. Its root is
  remounted read-only and scratch is a size-bounded fresh tmpfs. CPU,
  address-space, open-file, process-count, and per-file-size
  ceilings are independently probed alongside the hard deadline and output quota.
  Today that production isolation launcher is Linux-only (`bwrap` + `prlimit`)
  and fails closed on macOS and Windows.
- Office libraries never receive paths or URLs from model content. They receive
  bounded owned bytes and write to owned buffers or pre-opened scratch handles.
- Object-store identifiers and signed URLs are platform metadata, never artifact
  relationship targets. Egress is denied even if parser sanitization regresses.

## Required preflight budgets

Budgets are versioned policy inputs and part of the materialization cache key.
The first production profile should reject before expensive decode when any
single limit is exceeded:

| Resource | Initial ceiling |
| --- | ---: |
| compressed Office package | 64 MiB |
| ZIP entries | 20,000 |
| total declared expanded bytes | 512 MiB |
| one expanded entry | 128 MiB |
| compression ratio, entry and aggregate | 100:1 |
| nested archives | 0, except one internally related PPTX chart-data XLSX |
| XML depth / attributes per element | 128 / 256 |
| XML text, one part / aggregate | 64 MiB / 256 MiB |
| relationships, one part / package | 10,000 / 100,000 |
| formula UTF-8 / AST nodes / nesting | 64 KiB / 16,384 / 256 |
| referenced cells consumed per calculation transaction | 5,000,000 |
| dependency edges / recalculation fuel | 10,000,000 / policy-metered |
| decoded image pixels, one / artifact | 64 MP / 256 MP |
| render dimension / pixels | 32,768 px / 128 MP |
| model objects / text bytes | modality-specific, explicit, never unbounded |
| inspect response / canonical command bytes / mutation intent envelope | 1 MiB / 4 MiB / 5 MiB |

Declared sizes are not trusted. Streaming decoders meter actual output and stop
at the lower remaining limit. ZIP64, duplicate normalized names, encrypted
entries, absolute paths, `..`, NULs, ambiguous Unicode separators, overlapping
entries, malformed central directories, and data descriptors with inconsistent
sizes fail closed. Parsers do not follow nested archives except PPTX chart-data
workbooks referenced by the chart relationship graph. That exception is depth
one, shares global entry/expanded-byte budgets across every embedded workbook,
rejects formulas, external relationships, active content, and further nested
packages, and is never executed.

The browser-safe DOCX reference importer currently uses a deliberately tighter
profile: 32 MiB compressed, 64 MiB declared expanded, 24 MiB per expanded
entry, 16/32 MiB XML per-part/aggregate, 16 million retained XML characters,
100,000 XML nodes, and 100:1 compression. It inflates and parses exactly one
part at a time; ignored metadata/configuration trees and expanded buffers are
not cached. Semantic DTO/model allocations remain independently bounded.

## Office and relationship policy

OOXML is parsed with DTDs and all entity declarations disabled. XML readers cap
tokens, depth, attributes, namespaces, and text while streaming. Relationship
graphs cap nodes/edges and are resolved only after canonical path normalization.

Allowed internal relationships are an explicit per-format allowlist. External
relationships, remote templates, external data connections, linked pictures,
OLE/ActiveX, macros/VBA, embedded packages/executables, custom UI, and unknown
active content are quarantined. `http`, `https`, `file`, UNC, `javascript`, and
other URI schemes are never dereferenced. Hyperlink text/target may be retained
as inert metadata and requires an explicit user click through host policy.

Safe unknown OOXML may be preserved byte-for-byte only after content-type,
relationship reachability, path, size, and active-content classification. Any
edit that cannot merge it faithfully produces a typed fidelity error. The
caller must explicitly choose destructive export; “lossless” is never claimed.

Images are decoded from owned bytes, not URLs or paths. Allowed raster formats
are signature-sniffed and decoded with pixel/byte limits. SVG, PDF, fonts, ICC,
EXIF, and other structured media require dedicated sanitized pipelines; MIME
claims alone grant no capability. SVG scripts, event attributes, `foreignObject`,
external references, CSS URLs, entities, animation, and nested data documents
are rejected or reduced to a safe render-command representation.

## Formula policy

Formula source is parsed by the artifact grammar into an arena AST. It is never
passed to JavaScript evaluation, a shell, SQL, a template engine, or an Office
application. Only an allowlisted deterministic function registry is callable.

Network/data functions (`WEBSERVICE`, `HYPERLINK`, `IMPORTXML`, stocks), DDE,
RTD, VBA/UDFs, cube/external-workbook functions, and arbitrary plugins return a
typed unsupported/name error. Volatile functions require an explicit seeded
evaluation context. Parsing and evaluation consume source, node, depth,
reference-area, dependency-edge, allocation, and instruction fuel. Exceeding a
budget returns a typed limit error; it never partially commits cached values.

CSV/TSV exports must defend spreadsheet-formula injection as an export policy:
cells beginning with `=`, `+`, `-`, `@`, tab, or carriage return are quoted or
prefixed when the target may open them as formulas. Typed XLSX string cells stay
strings. An explicit raw-data export may opt out with a visible warning.

## Markup, scripts, and host isolation

Renderers construct typed render commands. Text and attribute contexts use
separate escaping; colors, fonts, transforms, dimensions, URLs, CSS, and data
URLs use strict parsers/allowlists rather than escaping alone. Generated HTML is
inert and rendered in a sandboxed origin/frame with scripts, forms, navigation,
popups, downloads, plugins, same-origin access, and network disabled by CSP.

The package never accepts a content-controlled filesystem path. `FileBlob.load`
and `save` are explicit host actions and must remain outside model import/render
APIs. Browser object URLs are created by the host from verified owned bytes and
revoked after use. The materializer parent receives only its dedicated database
URL and active object-storage credentials. Its native codec child receives none
of those credentials, no service-account mounts, and no user home.

## Collaboration and operation decoder

- Reject noncanonical encodings, invalid UTF-8, trailing bytes, unknown flags,
  duplicate actors, integer overflow, oversized strings/vectors/commands, and
  unsupported schema before apply.
- Decode maps use null-prototype storage or reserved-key-safe maps. Keys such as
  `__proto__`, `prototype`, and `constructor` cannot alter or disappear from
  semantic state.
- Commands are typed against the current modality/schema; unknown commands and
  fields fail closed. Payload JSON permits only null, booleans, finite numbers,
  strings, arrays, and ordinary records with bounded depth/nodes/bytes.
- The server derives actor/attempt authority, verifies causal bases and
  preconditions, applies atomically, hashes resulting state, then commits. Rate
  limits and quotas apply per principal/workspace/artifact/connection.

## Verification status and gates

Passing tests under `packages/artifact-tool/test/security` currently verify:

- command size/canonicality/malformed-input rejection, JSON depth/node limits,
  reserved causal actor preservation, and payload prototype-pollution resistance;
- formula capability denial for network/shell/import/DDE-like calls and inert
  CSV import, with bounded parse/evaluation/reference/dependency work;
- HTML/SVG escaping for ordinary untrusted text and attributes already routed
  through strict helpers, active image-source rejection, and explicit-only
  presentation image resolution;
- DOCX/PPTX import fail-closed behavior, malformed XLSX rejection, no fetch for
  external XLSX formulas/hyperlinks, no ZIP filesystem extraction, bounded ZIP
  expansion, DOCX/XLSX XML attribute and relationship fan-out, and rejection of
  applicable macro/OLE/entity/external-relationship parts;
- structural document/presentation geometry, decoded-image, and raster-output
  pixel bounds;
- canonical spreadsheet snapshot/aggregate validation and live/restored axis
  coordinate and dimension bounds.

No `SEC-*` adversarial test is currently skipped. Every newly discovered gap
must begin with a failing reproducer and become enabled before release. Before
untrusted production use, the native/WASM implementations must share the same
corpus, and fuzzing must cover ZIP/XML/relationship/media/formula/snapshot/
operation decoders under ASan/UBSan, cargo-fuzz/libFuzzer, malformed corpus
replay, allocation counters, and process-level CPU/RSS/output limits. Security
tests run with network denied and an empty filesystem namespace; product E2E
verifies CSP and user-visible quarantine/fidelity diagnostics.
