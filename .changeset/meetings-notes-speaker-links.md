---
"@opengeni/db": patch
---

A meeting's notes keep naming the right people after its transcript is run again. Speaker links in the notes (`[Name](speaker:speaker_0)`) name the labels of the version they were written about, and a new version numbers its voices afresh, so a link could show no one or a different voice. When another version becomes the shown one, each link now moves to the label whose speech overlaps most of its own (a track label stays itself), and a link with no counterpart becomes its plain text. The rewrite is a new notes revision and a `recording.notes.updated` event, and keeps who wrote the notes and when.
