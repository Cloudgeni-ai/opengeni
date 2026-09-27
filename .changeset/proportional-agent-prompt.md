---
"@opengeni/runtime": patch
"@opengeni/config": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Make agent effort proportional to the request. The operational contract now asks for a direct answer with minimal tool use on simple asks, reuse of the earlier approach on repeat asks, one-sentence progress updates without a forced opening update, answer-first final responses, and reading each Skill once without announcing it. A question asked mid-run gets an answer instead of restarting work; while work is still in flight the agent answers in one or two sentences in the user's terms, naming a blocker only when the user must act on it, and registers the wait again with the earlier reason and remaining time, even with an active goal, so its result still resumes the agent without pushing back a timed recheck, and a question alone no longer resumes a paused goal. Answers stay in chat by default; a document Artifact is created only when the user asks for one or the deliverable is large or meant to be kept or shared, and a session no longer creates a goal only to declare a document. The default persona is a general assistant; it works on a branch with a pull request only when the repository has a remote and git provider credentials, and otherwise leaves changes in the working tree without branch or pull request talk unless the user asks, saying only that the changes are not pushed when the repository has a remote, and the Sites and visualize Skill descriptors apply when the user asks or clearly benefits.
