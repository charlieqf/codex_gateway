# AlphaFold Gateway v1

Retired on 2026-10-21 after AF3 public acceptance. The following is historical
design evidence; do not re-enable its routes, configuration or credentials.
Use [AlphaFold 3 Gateway v1](./alphafold3-gateway-v1.md). AF2 has no compatibility
period or fallback service.

Public prefix `/gateway/alphafold/v1`; private upstream
`https://192.168.77.7:7448/internal/alphafold/v1`.
Profile: `alphafold2-monomer-public-msa-v1`.

Uses the existing clinical identity, owner derivation, durable intents, limits
and reconciliation. `GATEWAY_ALPHAFOLD_MODE=authenticated` permits all valid
existing and future accounts. Default allowance: ten tasks/day, one active task
per account. The independent database is
`/var/lib/codex-gateway/clinical/alphafold.db`.

`POST /jobs` accepts up to 64 KiB JSON, one sequence/FASTA of at most 4096 bytes,
16–130 standard residues, policy `public_or_authorized_sequence` and explicit
`external_msa_consent=true`. FASTA titles are removed before persistence and
forwarding. Original idempotency keys persist in this mode's private intent
database and are reused during recovery. New jobs return 202, replays 200.
There are no public upload or source routes. Progress retains the upstream
MSA/GPU/prediction phases. Sequences are never routed through a language model.

All seven artifact names are required; each is limited to 32 MiB. Downloads
are fully size/hash verified before HTTP success and retain original bytes,
MIME type, length and SHA-256. HTML is served as an attachment with sandbox CSP.
The `/result` endpoint returns the original verified result.json bytes, after
checking sequence identity, confidence bounds and the agreed prediction settings.
Errors retain upstream status and safe error codes; remote error messages are
replaced to avoid exposing sequence content, paths or credentials.

Only the public CA and service token are mounted read-only from
`/opt/codex-gateway-r760/secrets/alphafold-star-20261020/`.
The directory stays root/0700; files stay root:999/0440. TLS verification is
mandatory. The TLS private key remains on star.

Deploy a tested, committed main revision using the immutable release prepare
procedure and `scripts/ops/alphafold-gateway-cutover.py`. The cutover waits for
30 seconds of natural Gateway idle, drains, changes only the Gateway service
and clinical Nginx include, verifies convergence and database integrity, and
rolls back on failure. It does not change model services or GPU scheduling.

Acceptance must include a real public prediction, seven hashes, cross-account
denial including forged owner headers, running cancellation, deletion, and
EchoNet/EchoNext upload-to-download regression. Record sanitized receipts under
`docs/outbox`; never include service tokens or user credentials.
