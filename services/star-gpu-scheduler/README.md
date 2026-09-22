# star unified GPU scheduler

The image and CT APIs keep their existing contracts. The broker owns metadata
and resource admission; model execution stays in Qwen/RADAR. Production uses
`mode=enforce` and `GPU_SCHEDULER_REQUIRED=1` in every participating service.

## Scheduling and failure contract

- GPU0: images. GPU1: CT first, then images. No preemption of running work.
- One RADAR subprocess, including preprocessing; preprocessing reserves host
  memory without locking a GPU. Ready CT/preprocessing has memory priority.
- Each Qwen process has a 56 GiB cgroup bound. The broker reserves the difference
  between that limit and observed usage. A CT task reserves a conservative full
  32 GiB until exit, even after some memory has already been allocated. Host
  `MemAvailable` must retain the configured host reserve. The code/deployment
  default is 12 GiB; production was explicitly adjusted to 11 GiB on 2026-09-22
  to recover a blocked original CT study, keeping the CT reservation at 32 GiB.
  Preserve this live override in future release preparation; see the
  [recovery receipt](../../docs/operations/ct-memory-admission-recovery-2026-09-22.zh-CN.md).
  Dual Qwen execution is conditional on this budget, not a guarantee at all times.
- Temperature admission <=80 C; Qwen/RADAR abort at >=88 C. Minimum free VRAM is
  30000 MiB / 32768 MiB respectively. Unknown GPU processes stop admission.
- IndexTTS remains outside the shared lock. Its actual VRAM and host memory count
  toward admission; its concurrent growth is still a limitation of version 1.
- Images: four total outstanding, at most two executing, queue wait <=80 s and
  request budget <=170 s. Full queue: 429; unavailable/expired admission: 503.
  Existing Gateway cloud fallbacks remain. LLaDA is not restored.
- CT: original asynchronous job API/24 h resource expiry; waiting stage is
  `waiting_gpu`. Broker outage leaves unstarted business jobs queued. Existing
  service restart semantics require explicit retry for interrupted execution.
- Missing ticket, unavailable broker, bad telemetry/storage, wrong role,
  wrong payload hash, stale generation/token, or missing process-owned flock
  cannot start inference. A heartbeat timeout never releases an occupied GPU.
- Qwen initialization also holds a ticket and GPU lock. Failed CUDA cleanup
  exits the worker, with systemd restart attempts capped at three per ten minutes.

## Persistence and credentials

SQLite schema v1 contains `meta`, `tasks`, `slots`, and `events`. Tasks store a
validated JSON metadata record, indexed by role/operation; slots contain an
atomic generation and task reference. WAL + synchronous FULL are enabled.
Terminal records and events expire after 30 days. Do not delete or recreate
GPU lock files while the host is running. Receipt files contain no model inputs
and are kept in the user runtime directory until reboot (monitor inode usage).
The runtime directory is preserved across service restarts.

The broker uses a 0600 Unix socket inside a 0700 directory. Every request verifies
SO_PEERCRED, a distinct role token, and the calling systemd unit. Claim additionally
checks the actual PID holding the lock in `/proc/locks`. Tokens are never returned
by operator status or stored in SQLite; only a grant-token hash is persisted.
Task content stays in the original service. A digest binds grants to payloads.

## Offline checks

From the repository root, with the existing Qwen HTTP dependencies available:

```text
python services/star-gpu-scheduler/tests/run_offline.py /path/to/radar-imaging
node node_modules/vitest/vitest.mjs run apps/gateway/src/qwen-image-generation.test.ts
```

The Python runner blocks model-library imports, GPU/systemd commands and external
network connections. Fake Torch is inserted only in explicit worker cleanup
tests. Linux tests use real SQLite, Unix sockets, peer credentials, subprocesses
and flock. Run them on Linux; Windows skips these cases. No test calls a real
generation or CT inference endpoint.

## Controlled rollout

Use committed Gateway main and RADAR dev source archives. Build the pure Python
wheel from the committed artifact, `--no-deps`; install it without touching model
dependencies. Verify hashes against deployed source before preparing. Keep the
release directories immutable. Do not deploy a working tree.

`deploy.py prepare --manifest <protected JSON>` verifies expected current pointers
and source hashes, checks idle queues, backs up current units/configuration plus
an online SQLite backup, verifies the backup, creates 0600 role tokens and installs
the wheel. The manifest supplies `expected_current`, `expected_hashes`,
`qwen_release`, `radar_release`, `wheel`, and `wheel_sha256`.

`deploy.py activate` checks idle queues again, stops intake, stops idle workers,
switches source pointers/units, starts the broker and permits ticketed model
initialization. It leaves the two business services stopped. Verify broker status,
two completed `image_init` records, idle locks, correct GPU UUID/index mapping,
worker readiness, resource headroom, and unchanged IndexTTS before opening intake.

`deploy.py open` opens Qwen and RADAR intake. Then check unit health/restarts,
private image health, authenticated CT capabilities, SQLite quick checks,
public Gateway health and unchanged provider configuration. Do not infer a real
model acceptance result from these checks.

The user explicitly authorized production cutover after sufficient mock tests
on 2026-09-22. Consequently this rollout does not require the design's optional
real inference acceptance matrix, and does not submit real inference requests.
User traffic after opening is real and must acquire scheduler tickets.

## Recovery

Use the private operator CLI to `status`, `drain`, or `resume`, with optional
`--gpu 0|1`. Do not manually clear a task or slot when its executor is uncertain.
Confirm process exit / cgroup emptiness and lock release first. A stopped broker
can restart without losing running leases; claims carry the original token hash.

`deploy.py rollback` stops intake/executors, verifies no active RADAR child, restores
source pointers/units, removes GPU1 from the old pool's systemd dependencies and
disables the GPU1 Qwen worker. It starts Qwen on GPU0 and original RADAR on GPU1.
It never restores the database backup or starts LLaDA. Original model files,
certificates, API tokens, SSH tunnel and IndexTTS remain in place.
