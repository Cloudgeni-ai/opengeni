---
"@opengeni/config": patch
"@opengeni/core": patch
---

Skill preview and install can read GitHub with a deployment token, so they no longer share GitHub's anonymous 60 requests/hour limit. Set the optional `OPENGENI_SKILL_IMPORT_GITHUB_TOKEN` to a fine-grained token with public-repository read access only; reads with it still refuse any repository that isn't public, and an invalid token now says so. Generated runtime artifacts carry the setting when it is set. Thanks to @hadialjurdi7-dot.
