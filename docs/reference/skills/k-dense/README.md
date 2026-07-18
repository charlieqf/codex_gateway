# K-Dense skill snapshots

This directory contains third-party reference snapshots. They are not
production dependencies, are not self-contained, and must not be copied into a
runtime image or executed by the Doctor Research Worker.

## Provenance status

The files declare `skill-author: K-Dense Inc.` and an MIT license in their
SKILL.md frontmatter. The likely upstream collection is:

https://github.com/K-Dense-AI/scientific-agent-skills

The upstream HEAD observed during the 2026-07-17 audit was
`3f825caafe149b7853ec8c4d1dd7f4553ea6b2a5`. The original acquisition URL,
commit, and date for these local files were not recorded, so this observed HEAD
must not be represented as the snapshot's proven version.

Raw snapshot fingerprints use this deterministic algorithm: sort files by
slash-normalized relative path, append
`<relative-path><NUL><file-sha256><LF>` for each file, then SHA-256 the UTF-8
manifest bytes.

| Snapshot | Files | Tree SHA-256 |
|---|---:|---|
| `citation-management` | 16 | `a2c33e3aa60a35bed3aafa9c5bd54b89a9badf7fbcfbd1ef8e983f686a9ec12a` |
| `literature-review` | 9 | `e76a6cf4ab4196b88784bd5d35b1cc6acd15e3a08693b6871168dbc07057d33e` |
| `scientific-writing` | 13 | `885bc787b4390b9f28748e9a20e699f39cd44f688ef421ed7e2862dfe0199af8` |

## Known blockers

- SKILL.md command examples and bundled CLI implementations disagree. Some
  documented switches are absent, and `validate_citations.py --auto-fix`
  explicitly says it is not implemented.
- `search_google_scholar.py` scrapes Google Scholar and can route queries
  through a free public proxy, creating terms-of-service and data-disclosure
  risk.
- image/schematic scripts call OpenRouter with unapproved preview model IDs and
  search the current working directory for `.env`.
- referenced resources such as `research-lookup`,
  `scientific-schematics`, `venue-templates`, `parallel-cli`, and `gget` are
  not contained here.
- `generate_schematic.py` and `generate_schematic_ai.py` are byte-identical
  copies across all three snapshots.

Future production work must reimplement approved behavior behind allowlisted
TypeScript adapters and deterministic validators. It must not repair these
snapshots in place and then treat them as trusted upstream code.
