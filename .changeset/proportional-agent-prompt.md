---
"@opengeni/runtime": patch
"@opengeni/config": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Make agent effort proportional to the request. The operational contract now asks for a direct answer with minimal tool use on simple asks, reuse of the earlier approach on repeat asks, one-sentence progress updates without a forced opening update, answer-first final responses, and reading each Skill once without announcing it. A question asked mid-run gets an answer instead of restarting work; a wait on unchanged in-flight work is registered again after the answer so its result still resumes the agent, and a question alone no longer resumes a paused goal. Answers stay in chat by default; a document Artifact is created only when the user asks for one or the deliverable is large or meant to be kept or shared, and a session no longer creates a goal only to declare a document. The default persona is a general assistant with repository-conditional code guidance, and the Sites and visualize Skill descriptors apply when the user asks or clearly benefits.
