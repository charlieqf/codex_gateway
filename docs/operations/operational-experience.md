# Operational Experience

Last updated: 2026-08-31.

This file retains only cross-cutting lessons that change operational decisions.
Component-specific incidents and historical evidence belong in dated reports.

## Route Before Reading

- For a named user's Desktop messages, run
  `scripts/query-client-messages.py` immediately.
- Do not read deployment, migration, Azure or Research history before a routine
  read-only support query.
- Load one task-specific runbook from
  [Runbook Index](./runbook-index.md), not the whole operations directory.

## Desktop Message Queries

- Desktop original user prompts are stored in Gateway
  `client-events.db`, not MedEvidence v2 request tables.
- Query the target user and time window once, then filter locally and group by
  `session_id`.
- The admin page correlates Gateway model calls using
  `subject_id + client_message_id`; time proximity is not sufficient.
- A Gateway `ok` result proves the model-call chain completed. It does not
  prove a local PPTX/HTML/file exists, is valid or meets visual quality.
- Return only necessary prompt fragments and IDs. Do not expose phone numbers,
  credential prefixes, full keys or unrelated users.

## Incident Classification

The user-facing message is a symptom. Classify request events before acting:

- refresh-token evidence -> provider reauthentication;
- context overflow -> client/context compaction;
- 429 -> Gateway/provider capacity or quota;
- missing credential -> resolver/client credential;
- output length or truncated tool arguments -> long-output contract;
- successful Gateway calls with missing/bad artifacts -> Desktop/tool loop.

Do not restart or reauthenticate based only on a generic temporary-unavailable
message.

## PowerShell And SSH

- PowerShell can expand remote `$variables` and corrupt nested quoting.
- Keep simple read-only commands inline.
- Pipe reviewed UTF-8 scripts for multi-step Bash/Node/JSON work.
- Set or avoid non-ASCII script literals when the native pipeline's encoding is
  uncertain.
- Do not use a quote-heavy one-line SSH command as business logic.

## SQLite

- Prefer checked-in wrappers and admin CLI commands.
- For a bounded probe, use a read-only connection plus
  `PRAGMA query_only=ON`.
- Do not run migrations, `VACUUM`, prune, update or delete during diagnosis.
- Do not print broad rows that include phone, credential or secret metadata.
- Opening copied SQLite normally can create WAL/SHM sidecars; use read-only URI
  mode for verification.

## Deployment

- Preserve unrelated dirty files.
- Deploy a committed immutable revision, not a dirty working tree.
- Verify a pre-change backup before mutation.
- Run Compose validation without printing rendered secrets.
- Recreate only the intended service and keep Research overlays when required.
- Verify the exact bug path, not only generic health.
- Clean temporary users, credentials, reservations and files after smoke.
- Record current facts in `system-status.md`; put detailed evidence in a dated
  release report rather than appending it to the current-state document.
