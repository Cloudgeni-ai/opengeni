# @opengeni/ogtool

## 5.3.1

### Patch Changes

- Updated dependencies [c8ddf55]
- Updated dependencies [1988e97]
- Updated dependencies [e7f5d38]
- Updated dependencies [e3782bb]
- Updated dependencies [e1838ff]
- Updated dependencies [ce72530]
- Updated dependencies [4c6bf32]
- Updated dependencies [f3d19a2]
- Updated dependencies [f6f112a]
- Updated dependencies [2dc5e41]
- Updated dependencies [9f6cab2]
- Updated dependencies [6f6c356]
- Updated dependencies [d502ba3]
- Updated dependencies [cccd692]
- Updated dependencies [3fa5c6e]
- Updated dependencies [d6c7c4a]
- Updated dependencies [392db50]
- Updated dependencies [31bca3c]
- Updated dependencies [6acfbd3]
- Updated dependencies [21e7ecf]
- Updated dependencies [627b2f1]
- Updated dependencies [c307566]
- Updated dependencies [1cac78f]
- Updated dependencies [826b002]
- Updated dependencies [4998a79]
- Updated dependencies [4695d41]
- Updated dependencies [d6c7c4a]
- Updated dependencies [f9f0607]
- Updated dependencies [cc319f3]
- Updated dependencies [3b1d8c1]
- Updated dependencies [7d419e2]
- Updated dependencies [e5446f1]
- Updated dependencies [83682c3]
- Updated dependencies [a9809ee]
- Updated dependencies [acac580]
- Updated dependencies [f3d19a2]
- Updated dependencies [31c3308]
- Updated dependencies [e509f04]
- Updated dependencies [34f54fe]
- Updated dependencies [4e44f04]
- Updated dependencies [c194abb]
- Updated dependencies [0383280]
- Updated dependencies [7c02dbd]
  - @opengeni/contracts@5.3.0
  - @opengeni/codemode@5.3.0

## 5.2.1

### Patch Changes

- Updated dependencies [fb72b9d]
  - @opengeni/contracts@5.2.0
  - @opengeni/codemode@5.2.0

## 5.1.2

### Patch Changes

- @opengeni/codemode@5.1.0
- @opengeni/contracts@5.1.0

## 5.0.2

### Patch Changes

- Updated dependencies [487bd43]
- Updated dependencies [a9d20b3]
- Updated dependencies [6d29c01]
- Updated dependencies [217ed52]
  - @opengeni/contracts@5.0.0
  - @opengeni/codemode@5.0.0

## 4.8.0

### Patch Changes

- Updated dependencies [85fb89e]
  - @opengeni/contracts@4.8.0
  - @opengeni/codemode@4.8.0

## 4.7.2

### Patch Changes

- Updated dependencies [c6499fc]
- Updated dependencies [a6a1dac]
- Updated dependencies [8301382]
  - @opengeni/contracts@4.7.2
  - @opengeni/codemode@4.7.2

## 4.7.1

### Patch Changes

- @opengeni/codemode@4.7.1
- @opengeni/contracts@4.7.1

## 4.7.0

### Patch Changes

- Updated dependencies [31095f1]
  - @opengeni/contracts@4.7.0
  - @opengeni/codemode@4.7.0

## 4.6.1

### Patch Changes

- @opengeni/codemode@4.6.0
- @opengeni/contracts@4.6.0

## 4.5.0

### Patch Changes

- Updated dependencies [6c7b552]
- Updated dependencies [f838cb7]
- Updated dependencies [4e8a749]
- Updated dependencies [d0bc2d6]
- Updated dependencies [60e9756]
  - @opengeni/codemode@4.5.0
  - @opengeni/contracts@4.5.0

## 4.4.1

### Patch Changes

- Updated dependencies [e697879]
- Updated dependencies [11e56da]
- Updated dependencies [25d1500]
- Updated dependencies [dbc847f]
- Updated dependencies [81a516c]
- Updated dependencies [9c0c6d1]
- Updated dependencies [a75f55e]
- Updated dependencies [84b1a18]
  - @opengeni/contracts@4.4.0
  - @opengeni/codemode@4.4.0

## 4.3.1

### Patch Changes

- Updated dependencies [f1fd83b]
- Updated dependencies [659c01a]
- Updated dependencies [2963eca]
- Updated dependencies [374dd81]
- Updated dependencies [91329fc]
- Updated dependencies [46a2ef3]
- Updated dependencies [579239a]
- Updated dependencies [ffe09c2]
- Updated dependencies [1b57d74]
- Updated dependencies [277c99c]
- Updated dependencies [b20c9b2]
- Updated dependencies [70f0522]
- Updated dependencies [23fed2a]
- Updated dependencies [e4915c1]
- Updated dependencies [16781e5]
- Updated dependencies [7517fbc]
- Updated dependencies [6f150d1]
- Updated dependencies [9976132]
- Updated dependencies [724b529]
- Updated dependencies [3915617]
- Updated dependencies [4fadd37]
- Updated dependencies [9508318]
- Updated dependencies [b95784c]
- Updated dependencies [b603f10]
- Updated dependencies [67262de]
  - @opengeni/contracts@4.3.0
  - @opengeni/codemode@4.3.0

## 4.2.0

### Patch Changes

- c27cffc: Make bulk browser work easy to script with Opengeni's own browsers. `navigate` takes an optional `waitUntil` (`load` or `network_idle`), and `viewport` defaults to desktop layout when `mobile` is omitted. `tab.navigate(url, { waitUntil })` passes it through in Code Mode. An explicit `load` wait now waits for the page's load event (images and other subresources finished), not just a parsed document. `ogtool call` and the native `codemode call` now write image blocks such as screenshots to files and print their paths instead of base64 pixels, and `--save-image <path>` saves the single image at an exact path. An existing `--save-image` path is refused before the call; a completed call whose image cannot be saved still prints its result with `imageSaveError` and exits with status 4. Expired temporary image directories are removed only when private and owned by the same user.
- Updated dependencies [c27cffc]
- Updated dependencies [641e179]
- Updated dependencies [e018445]
- Updated dependencies [5715a3e]
- Updated dependencies [47eeb80]
  - @opengeni/codemode@4.2.0
  - @opengeni/contracts@4.2.0

## 4.1.3

### Patch Changes

- @opengeni/codemode@4.1.2
- @opengeni/contracts@4.1.2

## 4.1.1

### Patch Changes

- Updated dependencies [afff3f9]
- Updated dependencies [e4e30b8]
- Updated dependencies [57e3a3e]
- Updated dependencies [9be9a82]
  - @opengeni/contracts@4.1.0
  - @opengeni/codemode@4.1.0

## 4.0.4

### Patch Changes

- Updated dependencies [e7113e3]
- Updated dependencies [26b4c24]
- Updated dependencies [2f6b8bd]
- Updated dependencies [9482fe0]
- Updated dependencies [2a81601]
- Updated dependencies [71dfe30]
- Updated dependencies [f010292]
- Updated dependencies [9fb9db3]
- Updated dependencies [79ec9fd]
- Updated dependencies [5927aae]
- Updated dependencies [6ab7b55]
- Updated dependencies [3e061d6]
- Updated dependencies [a22ed79]
- Updated dependencies [9ddadf6]
  - @opengeni/contracts@4.0.0
  - @opengeni/codemode@4.0.0

## 3.4.0

### Patch Changes

- Updated dependencies [28844d8]
- Updated dependencies [ceaf911]
- Updated dependencies [c594c1d]
- Updated dependencies [7998676]
- Updated dependencies [7998676]
  - @opengeni/contracts@3.4.0
  - @opengeni/codemode@3.4.0

## 3.3.0

### Patch Changes

- Updated dependencies [38ac98e]
  - @opengeni/contracts@3.3.0
  - @opengeni/codemode@3.3.0

## 3.2.2

### Patch Changes

- Updated dependencies [a0c35a1]
  - @opengeni/contracts@3.2.0
  - @opengeni/codemode@3.2.0

## 3.1.2

### Patch Changes

- Updated dependencies [17d61c6]
- Updated dependencies [99d545d]
- Updated dependencies [1e67711]
- Updated dependencies [0bdb953]
- Updated dependencies [79af429]
- Updated dependencies [877c70d]
  - @opengeni/contracts@3.1.0
  - @opengeni/codemode@3.1.0

## 3.0.0

### Patch Changes

- Updated dependencies [501bb83]
- Updated dependencies [2077293]
- Updated dependencies [db3efc5]
- Updated dependencies [957f6ee]
- Updated dependencies [6339cec]
- Updated dependencies [37169cd]
- Updated dependencies [d367818]
  - @opengeni/contracts@3.0.0
  - @opengeni/codemode@3.0.0

## 2.0.1

### Patch Changes

- Updated dependencies [2ea5f7b]
  - @opengeni/contracts@2.0.1
  - @opengeni/codemode@2.0.1

## 2.0.0

### Patch Changes

- Updated dependencies [fc57bd2]
- Updated dependencies [04ebc42]
- Updated dependencies [e03f1ff]
- Updated dependencies [c2f4153]
- Updated dependencies [de2d721]
- Updated dependencies [055015d]
- Updated dependencies [1ee99c1]
- Updated dependencies [1756cfe]
- Updated dependencies [40e2542]
- Updated dependencies [6861501]
- Updated dependencies [bfed4f1]
- Updated dependencies [4532435]
- Updated dependencies [f96605f]
- Updated dependencies [496ce55]
- Updated dependencies [3822e5f]
- Updated dependencies [3962da3]
- Updated dependencies [c4dd318]
- Updated dependencies [ce7b403]
- Updated dependencies [445baf4]
- Updated dependencies [5b4a738]
- Updated dependencies [334c470]
- Updated dependencies [96d7167]
- Updated dependencies [f7d53b2]
- Updated dependencies [c13d080]
- Updated dependencies [061ae01]
- Updated dependencies [810d1d9]
- Updated dependencies [8e7cb8d]
- Updated dependencies [6313dd8]
- Updated dependencies [945490f]
- Updated dependencies [8e878ac]
- Updated dependencies [9701372]
- Updated dependencies [bc40348]
- Updated dependencies [5eb1c32]
- Updated dependencies [da01634]
- Updated dependencies [ab3306a]
- Updated dependencies [4cb80a9]
- Updated dependencies [eb68b58]
- Updated dependencies [38b1ba1]
- Updated dependencies [6960770]
- Updated dependencies [3426850]
- Updated dependencies [412671a]
- Updated dependencies [63bf721]
- Updated dependencies [3a4a435]
- Updated dependencies [14343e4]
- Updated dependencies [2b8ee21]
- Updated dependencies [71c42bf]
- Updated dependencies [a390b9e]
- Updated dependencies [6861501]
- Updated dependencies [a81a567]
- Updated dependencies [6861501]
- Updated dependencies [6861501]
- Updated dependencies [322f26c]
- Updated dependencies [945c247]
- Updated dependencies [e8c3557]
- Updated dependencies [5cdfbaa]
- Updated dependencies [5cb6d71]
- Updated dependencies [732a788]
- Updated dependencies [8cf9e0a]
- Updated dependencies [726bdc1]
- Updated dependencies [11779ba]
- Updated dependencies [66b3026]
- Updated dependencies [844c089]
- Updated dependencies [7ce535f]
- Updated dependencies [35fb6fd]
- Updated dependencies [35fb6fd]
- Updated dependencies [7bf1a02]
- Updated dependencies [a13bf1a]
- Updated dependencies [a91718c]
  - @opengeni/contracts@2.0.0
  - @opengeni/codemode@2.0.0

## 1.4.4

### Patch Changes

- Updated dependencies [6384dbd]
  - @opengeni/contracts@1.4.4
  - @opengeni/codemode@1.4.4

## 1.4.3

### Patch Changes

- @opengeni/codemode@1.4.3
- @opengeni/contracts@1.4.3

## 1.4.2

### Patch Changes

- @opengeni/codemode@1.4.2
- @opengeni/contracts@1.4.2

## 1.4.1

### Patch Changes

- Updated dependencies [fe1f64d]
- Updated dependencies [9145bad]
- Updated dependencies [f290348]
  - @opengeni/codemode@1.4.1
  - @opengeni/contracts@1.4.1

## 1.4.0

### Minor Changes

- 08ce841: `ogtool call` prints a tool result's payload once: a text block that only repeats `structuredContent` as JSON is omitted, and `--full` prints the exact result. The rule is exported from `@opengeni/contracts` as `omitStructuredContentTextDuplicates` and is shared with the runtime's model-facing MCP projection and the native Connected Machine client.

### Patch Changes

- Updated dependencies [bd9521c]
- Updated dependencies [08ce841]
- Updated dependencies [673bb53]
  - @opengeni/contracts@1.4.0
  - @opengeni/codemode@1.4.0

## 1.3.0

### Patch Changes

- 178b5ae: Unify connector Allow, Ask first and Block decisions across tool transports and settings. Add durable programmatic approval handles, exact stored-operation continuation, and shared review facts with portable React presentation and paginated protected details.

  Add lightweight Gmail message selection and bounded pagination/chunk helpers. Preserve exact access checks, uncertain outcomes and existing client compatibility. Deploy matching API, worker and native runtime artifacts through the documented maintenance migration.

- Updated dependencies [178b5ae]
  - @opengeni/codemode@1.3.0

## 1.2.0

### Patch Changes

- @opengeni/codemode@1.2.0

## 1.1.0

### Patch Changes

- @opengeni/codemode@1.1.0

## 1.0.2

### Patch Changes

- @opengeni/codemode@1.0.1

## 1.0.0

### Major Changes

- Reset package versioning: every published `@opengeni/*` package now releases together at one shared version, starting at 1.0.0. Install all `@opengeni` packages at the same version. Earlier versions are retired.

## 0.3.53

### Patch Changes

- @opengeni/codemode@0.7.2

## 0.3.52

### Patch Changes

- @opengeni/codemode@0.7.1

## 0.3.51

### Patch Changes

- Updated dependencies [da4ba6f]
  - @opengeni/codemode@0.7.0

## 0.3.50

### Patch Changes

- @opengeni/codemode@0.6.8

## 0.3.49

### Patch Changes

- @opengeni/codemode@0.6.7

## 0.3.48

### Patch Changes

- @opengeni/codemode@0.6.6

## 0.3.47

### Patch Changes

- Updated dependencies [359382e]
  - @opengeni/codemode@0.6.5

## 0.3.46

### Patch Changes

- @opengeni/codemode@0.6.4

## 0.3.45

### Patch Changes

- @opengeni/codemode@0.6.3

## 0.3.44

### Patch Changes

- @opengeni/codemode@0.6.2

## 0.3.43

### Patch Changes

- @opengeni/codemode@0.6.1

## 0.3.42

### Patch Changes

- 9d9b94b: Keep the published dependency closure aligned with the updated plugin removal
  contracts. The SDK exposes named removal outcomes and optional preview-token
  confirmation alongside the existing installation-version check.
- Updated dependencies [9d9b94b]
- Updated dependencies [0ea365c]
  - @opengeni/codemode@0.6.0

## 0.3.41

### Patch Changes

- @opengeni/codemode@0.5.9

## 0.3.40

### Patch Changes

- Updated dependencies [750060c]
  - @opengeni/codemode@0.5.8

## 0.3.39

### Patch Changes

- Updated dependencies [e41027c]
  - @opengeni/codemode@0.5.7

## 0.3.38

### Patch Changes

- @opengeni/codemode@0.5.6

## 0.3.37

### Patch Changes

- @opengeni/codemode@0.5.5

## 0.3.36

### Patch Changes

- @opengeni/codemode@0.5.4

## 0.3.35

### Patch Changes

- @opengeni/codemode@0.5.3

## 0.3.34

### Patch Changes

- @opengeni/codemode@0.5.2

## 0.3.33

### Patch Changes

- Updated dependencies [5904fd1]
  - @opengeni/codemode@0.5.1

## 0.3.32

### Patch Changes

- c1dc59b: Make CLI catalog discovery compact by default, showing callable paths and short
  Unicode-safe descriptions. Add compact `list --json`, retain the previous full
  catalog output under `list --full`, and add bounded single-tool `show` details and
  schemas. Default text and compact JSON list all authorized catalog entries without
  an aggregate byte cap or default pagination. Accept literal `--query` filtering and
  strictly opt-in `--limit`/`--offset` compatibility slices with continuation metadata.
  Existing scripts parsing full catalog JSON must opt into `--full`.
  Escape terminal control characters in compact text descriptions only without
  rewriting catalog or JSON content or dropping rows after escape expansion.
  Mirror discovery behavior in the Connected Machine native Codemode CLI.
- Updated dependencies [b1d3673]
- Updated dependencies [107aa14]
- Updated dependencies [d8a70ec]
  - @opengeni/codemode@0.5.0

## 0.3.31

### Patch Changes

- @opengeni/codemode@0.4.27

## 0.3.30

### Patch Changes

- @opengeni/codemode@0.4.26

## 0.3.29

### Patch Changes

- @opengeni/codemode@0.4.25

## 0.3.28

### Patch Changes

- @opengeni/codemode@0.4.24

## 0.3.27

### Patch Changes

- @opengeni/codemode@0.4.23

## 0.3.26

### Patch Changes

- @opengeni/codemode@0.4.22

## 0.3.25

### Patch Changes

- @opengeni/codemode@0.4.21

## 0.3.24

### Patch Changes

- @opengeni/codemode@0.4.20

## 0.3.23

### Patch Changes

- @opengeni/codemode@0.4.19

## 0.3.22

### Patch Changes

- @opengeni/codemode@0.4.18

## 0.3.21

### Patch Changes

- @opengeni/codemode@0.4.17

## 0.3.20

### Patch Changes

- @opengeni/codemode@0.4.16

## 0.3.19

### Patch Changes

- @opengeni/codemode@0.4.15

## 0.3.18

### Patch Changes

- @opengeni/codemode@0.4.14

## 0.3.17

### Patch Changes

- a78124f: Adopt the canonical Bun 1.4 toolchain, build the standalone ogtool CLI with Bun, and use Bun 1.4's corrected UTF-8 byte-length behavior in runtime context compaction.
  - @opengeni/codemode@0.4.13

## 0.3.16

### Patch Changes

- @opengeni/codemode@0.4.12

## 0.3.15

### Patch Changes

- @opengeni/codemode@0.4.11

## 0.3.14

### Patch Changes

- Updated dependencies [29a44c2]
  - @opengeni/codemode@0.4.10

## 0.3.13

### Patch Changes

- @opengeni/codemode@0.4.9

## 0.3.12

### Patch Changes

- @opengeni/codemode@0.4.8

## 0.3.11

### Patch Changes

- @opengeni/codemode@0.4.7

## 0.3.10

### Patch Changes

- @opengeni/codemode@0.4.6

## 0.3.9

### Patch Changes

- Updated dependencies [79f57b5]
  - @opengeni/codemode@0.4.5

## 0.3.8

### Patch Changes

- @opengeni/codemode@0.4.4

## 0.3.7

### Patch Changes

- @opengeni/codemode@0.4.3

## 0.3.6

### Patch Changes

- Updated dependencies [944be7f]
  - @opengeni/codemode@0.4.2

## 0.3.5

### Patch Changes

- @opengeni/codemode@0.4.1

## 0.3.4

### Patch Changes

- Updated dependencies [b0b2bed]
  - @opengeni/codemode@0.4.0

## 0.3.3

### Patch Changes

- @opengeni/codemode@0.3.3

## 0.3.2

### Patch Changes

- @opengeni/codemode@0.3.2

## 0.3.1

### Patch Changes

- @opengeni/codemode@0.3.1

## 0.3.0

### Minor Changes

- d2def0c: Add the complete browser-native and semantic computer interaction system across managed sandboxes, Connected Machines, attached Chrome, and external browser placements. Ship durable browser identities, authentication repair, network routing, downloads/uploads, shared causal control, public SDK and React workbench surfaces, and one exact MCP/Codemode execution catalog with native Connected Machine access.

### Patch Changes

- Updated dependencies [d2def0c]
  - @opengeni/codemode@0.3.0

## 0.2.2

### Patch Changes

- @opengeni/codemode@0.2.2

## 0.2.1

### Patch Changes

- @opengeni/codemode@0.2.1

## 0.2.0

### Minor Changes

- dcfe6eb: Add canonical attempt-scoped CodeMode, browser and computer interaction, and durable collaborative editable artifacts. Agents and humans now share one artifact head through the same application authority; direct MCP and CodeMode support bounded inspection, fenced edits, trusted Office import, and asynchronous export to workspace files. The session UI gains a first-class Artifacts workspace, and React interaction viewers move to an explicit lazy-loadable subpath.

### Patch Changes

- Updated dependencies [dcfe6eb]
  - @opengeni/codemode@0.2.0

## 0.1.0

### Minor Changes

- 334b63f: Publish the dependency-free Toolspace CLI, consume its canonical source from stock sandbox images, and expose an exact deployment-pinned bootstrap hint so custom rigs and connected machines can install it without ever guessing `latest`.
