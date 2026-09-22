# Qwen-Image-2.1 deployment and comparison with LLaDA

Research evaluation completed on 2026-09-22. The subsequent user request authorizes promotion to the preferred Gateway image upstream and client testing. Historical evaluation results below retain their original configuration.

Canonical source is this directory on Gateway main. Deploy a `git archive` of a tested committed revision to the new research service's immutable `releases/<commit>` directory, and point its `current` symlink there. Do not deploy unrelated Gateway files or the dirty development checkout. Model/data downloads and evaluation outputs remain outside the source release.

## Target and isolation

- Host: star, Ubuntu 22.04, NVIDIA driver 570.211.01, 2x RTX 6000 Ada 48GB.
- Original LLaDA: GPU0, user service llada-image-api, loopback port 8190; stopped/disabled by the authorized dual-Qwen replacement below, with files retained.
- Existing IndexTTS: GPU1, about 8600 MiB resident; preserved without restart.
- Qwen: separate `/data/apps/qwen-image-21-eval`; the original evaluation uses GPU1/port 8191, while the replacement uses GPUs 0/1 on 8200/8201 behind the private 8191 pool.
- BF16 model CPU offload; PyTorch allocator capped at 58% of GPU memory. Original evaluation thermal admission/stop are 60/85 C; replacement units use 80/88 C as authorized below.
- Service remains private under the Qwen Research License; the Gateway connects through a pinned SSH tunnel and a separate upstream credential.
- The initial read-only R760 preflight encountered an existing NVML driver/library mismatch. The image route does not use R760 GPU inference.

## Reproducibility

- HF model reference revision: `790c92633540aa0cb11d9abf19eb46d861714758`.
- ModelScope official mirror is used because star cannot directly reach Hugging Face.
- `download_model.py` pins each file to the revision returned in a saved official manifest and verifies its SHA256 and byte size.
- Diffusers source snapshot: `7263f3317f6b392d62f41e9d75ed9d7e21fc5a5c`.
- Downloaded Diffusers ZIP SHA256: `e4a1a88ff1b013f4f606d7234d23ec89dea03a4b50212afd2a56fddbb2878251`.
- Isolated Python venv inherits existing read-only Torch 2.8.0 CUDA12.8 packages. New Transformers/Diffusers are installed only inside the new venv.
- `evaluation_plan.json` records prompts, seeds, scoring criteria and deployment differences before generation.

## Comparison limits

- 8 scenes x 2 seeds, 1024x1024, one PNG per request, no prompt rewriting.
- LLaDA: deployed FP8 Turbo at 4 steps. Qwen: official BF16 at 40 steps, CPU offload.
- Same GPU model but separate physical GPUs. Requests are serial; GPU utilization, temperature and memory are captured.
- End-to-end local HTTP timing includes generation, PNG serialization and base64 response. Warmup is reported separately.
- These are deployed-configuration comparisons, not a precision-matched or isolated architecture speed benchmark.
- Alpha generation and single-image editing are separate Qwen capability checks, excluded from shared T2I scores.
- Visual review is a single assistant's qualitative assessment, not an independent blinded human study.

## Results and report

The deployment receipt and measured results are in `docs/operations/qwen-image-21-evaluation-2026-09-22.zh-CN.md`. Local artifacts are under `C:/work/code/.task-artifacts/qwen-image-21-20260922`; server originals are under `/data/apps/qwen-image-21-eval/results`.

Run `sync_results.py <llada|qwen> <artifact-directory>` on the workstation to retrieve result JSONL and missing original PNGs with SHA256 verification. `build_report.py <artifact-directory>` combines both datasets with `visual-review.json`. `validate_report.py <artifact-directory>` checks all 16 shared pairs, two Qwen capability checks, PNG dimensions/hashes and HTML local references. It does not claim browser-render verification.

Final shared-suite means were 13.64 seconds for LLaDA and 58.52 seconds for Qwen; each completed 16/16. The single-assistant pair preferences were Qwen 9, LLaDA 2, ties 5. Alpha generation and changing only the red cup's color passed their separate checks. Results support task-specific selection, not a blanket model replacement.

## Gateway promotion

The API now requires `QWEN_IMAGE_API_KEY` from protected `api.env`, generates a random seed when absent, and uses the existing temperature/memory/concurrency guards. The unit is enabled on boot during promotion and restarts on failure. `test_qwen_api.py` validates authentication and admission without loading the model. `scripts/ops/prepare-qwen-image-link.py` provisions the restricted, pinned SSH link; `activate-qwen-image-r760.py` performs the backed-up Gateway cutover and public smoke with automatic config/image rollback. LLaDA becomes the first fallback before the existing external providers.

## Authorized replacement with two Qwen workers

The user subsequently approved replacing LLaDA with two independent Qwen replicas.
`qwen-image-worker@0` and `@1` bind physical GPUs 0 and 1 and loopback ports
8200/8201. `qwen-image-pool` preserves the existing authenticated loopback 8191
contract and SSH tunnel. Its single-process FIFO scheduler runs at most two
requests and retains up to two more pending jobs; queue wait is capped at 80
seconds within a 170-second total request budget. Busy, cooling or unavailable
workers are not assigned work. Dispatched requests are never internally retried;
client cancellation or transport timeout does not make a still-running GPU free.

Both workers use the verified BF16/40-step CPU-offload profile, with separate
compiler caches and 56 GiB per-process system-memory limits. IndexTTS is retained.
The user requested relaxed thermal admission: these units admit at up to 80 C
and abort generation at 88 C. The original evaluation unit defaults remain
60/85 C. Live nvidia-smi on 2026-09-22 reported target 85 C and a T.Limit margin
corresponding to maximum operating temperature 91 C on both cards. No power,
fan or driver setting is changed. See NVIDIA's T.Limit definition:
https://docs.nvidia.com/deploy/nvidia-smi/.

`retire-llada-gateway.py` removes only `MEDCODE_IMAGE_LLADA_*` settings after a
protected backup; it reuses the existing committed Gateway image, validates
Qwen followed by GPT Image 2, and preserves all other containers/configuration.
`activate-qwen-dual-star.py` backs up and disables the old Qwen unit, LLaDA API
and its dedicated Cloudflare tunnel, then starts the workers and pool from a
committed immutable release. It automatically restores the old source/unit
states if activation fails. Keep LLaDA files and venv for rollback and the
Qwen environment's inherited Torch dependency.

Run `test_qwen_api` and `test_qwen_pool` in the existing Python environment
without loading GPU models. After activation, `verify-qwen-dual.py private`
measures a serial baseline, a simultaneous pair and a four-request queued burst;
`public` checks two actual Gateway requests, formats/provider attribution,
ordinary text and temporary-identity cleanup. These scripts write no credentials
to output. Installed-client acceptance remains a separate handoff.
