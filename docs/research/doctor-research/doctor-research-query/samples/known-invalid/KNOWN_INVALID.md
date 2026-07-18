# Known-invalid material

Nothing under this directory is a golden fixture or executable Skill input.
Automated fixture discovery must exclude the entire subtree.

- `martin/` contains the quarantined historical output sample.
- `doctor-research-query-legacy.skill` is the pre-2026-07-17 archive whose
  embedded SKILL.md lacked the current prompt-injection and deterministic
  validation rules. It is retained only to make the replacement auditable.

The current `doctor-research-query.skill` at the Skill root is rebuilt from,
and byte-matches, the adjacent reviewed `SKILL.md`.
