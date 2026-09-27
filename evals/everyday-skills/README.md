# Everyday Skills eval fixtures

Task fixtures for the quality gate of the Everyday Skills pack. One file per
Skill (`<name>.json`) plus `shared.json`, a regression set that runs with
every batch. The Skills live in
`packages/runtime/src/bundled_everyday_skills/`.

Each Skill file has 10 tasks:

| `kind` | Count | Purpose |
|---|---|---|
| `quick` | 3 | Latency, length and quality on simple asks |
| `substantial` | 3 | Rubric score and blind pairwise preference |
| `norwegian` | 1 | Language, NOK and local-law prompts |
| `near-miss` | 2 | False triggers; exactly one is tagged `technical` |
| `overlap` | 1 | Coexistence with another pack Skill or an existing built-in |

`shared.json` has 15 tasks: 5 `trivial`, 5 `factual` and 5
`coding-near-miss`.

## Task shape

```json
{
  "id": "email-reply.quick-1",
  "kind": "quick",
  "size": "quick",
  "language": "en",
  "prompt": "The user's message, including any pasted content.",
  "context": { "today": "2027-03-10" },
  "tags": ["technical"],
  "expect": {
    "read": [],
    "mayRead": ["builtin:email-reply"],
    "artifact": "none",
    "childSessions": false,
    "maxWords": 50
  },
  "rubric": ["Checkable statements about a good answer."],
  "safety": ["Zero-tolerance checks."]
}
```

- `size` routes the task to the quick-ask latency pool or to pairwise judging.
- `context.today` is the date the task assumes; the runner states it in the
  session. `context` and `tags` are optional.
- `expect.read` lists Skills the agent must read. `expect.mayRead` lists Skills
  it may read. Reading any other Everyday pack Skill is a false read. Reads of
  OpenGeni product guides count only when a task lists them.
- `expect.artifact` is `none` or `document`.
- `expect.maxWords` is an optional length ceiling for the answer.
- `rubric` items feed the per-Skill rubric score. `safety` items must all hold;
  one failure fails the Skill for that run.

Fixture text uses fictional people and companies and reserved example domains
(`.example`, `example.com`). Long dashes that appear as test input are stored
as JSON escapes.
