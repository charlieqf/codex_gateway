# AlphaFold 3 Gateway v1

Public prefix: `/gateway/alphafold3/v1`. Private upstream:
`https://192.168.77.7:7449/internal/alphafold3/v1`.
Profile: `alphafold3-monomer-public-msa-v1`.

AF3 is the only supported protein mode. AF2 service registration, public routes,
profile, PDB allowlist and result validator were removed after AF3 public
acceptance on 2026-10-21. There is no compatibility route, redirect, task
migration or AF2 fallback. Historical receipts remain evidence, not deployment
instructions. The retired AF2 database is not opened or migrated by Gateway.

Existing and future authenticated accounts use the same identity and stable
owner isolation as the clinical services. `GATEWAY_ALPHAFOLD3_*` selects its
independent database `/var/lib/codex-gateway/clinical/alphafold3.db`, private
URL, CA and token. Limits remain ten jobs/day and one active job per account.
CA/token mounts under `/run/secrets/alphafold3/` are read-only. The private key
stays on star; TLS verification is mandatory.

Create requests accept up to 64 KiB JSON and one 16–130 residue standard protein
sequence, at most 4096 UTF-8 bytes. A single FASTA title is discarded. The
required policy is `public_or_authorized_sequence` with explicit
`external_msa_consent=true`. Original idempotency keys survive durable recovery;
new jobs return 202 and identical replays 200. There are no upload/source routes.

One AF3 network produces five diffusion samples with seed 0, ten recycles,
bucket 256 and XLA attention, without templates, relaxation or a local data
pipeline. Capabilities use `fields.num_recycle`; results use
`settings.num_recycles`. AF3 validates atom and CA confidence separately, pTM,
sequence identity, numeric clash flags, five unique seed/sample pairs and
ranking scores from -100 to 1.5. It does not require AF2 result fields.

The immutable manifest requires exactly seven files: `result.json`, `report.csv`,
`preview.png`, `structure.cif`, `scores.json`, `structure.html`, `models.zip`.
Each is at most 32 MiB. All bytes are size/hash verified before HTTP success;
MIME, Content-Length and SHA-256 are preserved. `/result` returns the original
verified JSON bytes. Downloads use `no-store, no-transform`; Nginx gzip is off.
HTML is an attachment with a sandbox CSP.

Release from tested, committed main using the immutable container procedure.
The one-time retirement script requires a passed AF3 public receipt, preserves
unrelated environment/mounts and removes only AF2 settings and mounts. It has no
automatic rollback to AF2, and the active `previous` pointer does not select an
AF2-enabled release. Future release rollback targets must also exclude AF2.

The original AF3 server team owns star's AF2 service/weight/environment
retirement and the independent ColabFold 1.6.3 MSA environment. Gateway acceptance
does not establish completion of that separate work or installed Desktop
acceptance. See the dated Gateway receipt under
`docs/outbox/alphafold3-gateway-acceptance-2026-10-21/`.
