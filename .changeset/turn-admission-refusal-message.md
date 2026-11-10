---
"@opengeni/worker-bundle": patch
---

A turn refused at admission now says why in `turn.failed` instead of "Activity task failed". This covers fixed refusal messages such as a connected subscription used for API work, missing workspace or API credits, a paid plan or paid credit being required, and a monthly agent-run or token limit being reached. These refusals now throw `TurnAdmissionRefusedError`, which the workflow lists as a diagnosable turn failure. The refusal policy itself is unchanged.
