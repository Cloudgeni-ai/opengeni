# The literal secret-reference escape applies to files too

An agent documenting a harness wrote a secret reference into a README to show
how to use it. References are resolved in file writes, so the real value landed
in the file and was committed. The escape that keeps a reference literal
already worked on every write path (apply_patch, shell redirects, editors,
connector calls), but the prompt only showed it for shell commands and
`ogtool call`, framed as passing a reference on. The sentence now states the
general rule: the escape keeps a reference as literal text anywhere, in files
as well as commands. It names no task or file type.

Size: +65 bytes (95 to 160) in the `secrets` module. The sentence was added by
`2026-11-11-legacy-sentence-edits.md`, so its `diff` line there is reworded:

```text
- In a shell command or script, including `ogtool call`, write `\{{secret:Item}}` to pass one on.
+ Write `\{{secret:Item}}` to keep a reference as literal text, in files as well as commands, for example to document one or to pass one on through `ogtool call`.
```

Tool-result text also changes. The missing-secret and syntax hints from secret
resolution say the escape applies to files as well as commands:

```text
- If the reference was meant to reach another workspace, chat or later work unresolved, write it as \{{secret:…}} and retry.
+ If the reference was meant to stay literal text, in a file, a command or work it is passed on to, write it as \{{secret:…}} and retry.
- Escape a literal reference as \{{secret:…}}.
+ Write a reference meant as literal text, in files as well as commands, as \{{secret:…}}.
```

A `git commit` or `git push` through `exec_command` or `run_on` whose content
contains a secret value resolved earlier in the session is no longer run. The
tool result starts with "Nothing was run:", names each file and line (and the
commit for a push), and says how to write the reference literally, amend an
earlier commit or ignore a local file. It appears only when such a value is
found, so ordinary turns and the prompt cache are unaffected.
