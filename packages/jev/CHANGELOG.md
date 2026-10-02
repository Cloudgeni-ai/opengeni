# @opengeni/jev

## 0.2.1

### Patch Changes

- 48f5d39: `code_search` packs "must change together" declarations after the passages that passed the relevance bar instead of before them, so they no longer push verified passages out of the token budget.

## 0.2.0

### Minor Changes

- 87f5393: `code_search` now aims to cut irrelevant reading without hiding relevant code. It follows the identifiers of the relevant files to their definitions and usages, including files no keyword matched. It judges every function of small relevant files, asks which functions of the most relevant files must change together with the asked change, checks call sites of the definitions it follows, and refills the budget when its evidence rating is low. Each pack ends with a map of the relevant files that names the line ranges and declarations it did not show. It also reports every limit that cut something, and keywords that matched nothing (or only irrelevant files) together with similar identifiers that exist in the workspace.

### Patch Changes

- 6146167: `code_search` never searches or returns platform credential material. `.opengeni/` (Codemode tokens, Git credential files and bindings), `.azure/` (the Azure CLI login cache) and `.config/opengeni/` (Connected Machine enrollment credentials) are excluded at any depth from every ripgrep call, and an explicit path into one of them, in any spelling or through a symlink, is ignored.

## 0.1.0 - initial

- Native TypeSafe Jev client (chunking within the request limits, bounded retries, abort, typed errors) and an in-process circuit breaker.
- The `code_search` engine, a port of the validated scout-0.3.1 research tool behind an injected workspace interface, plus its model-facing tool surface.
