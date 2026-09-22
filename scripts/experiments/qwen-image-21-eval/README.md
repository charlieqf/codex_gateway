# Qwen-Image-2.1 deployment and comparison with LLaDA

Research evaluation requested on 2026-09-22. Production Gateway routing is out of scope.

Canonical source is this directory on Gateway main. Deploy a `git archive` of a tested committed revision to the new research service's immutable `releases/<commit>` directory, and point its `current` symlink there. Do not deploy unrelated Gateway files or the dirty development checkout. Model/data downloads and evaluation outputs remain outside the source release.

## Target and isolation

- Host: star, Ubuntu 22.04, NVIDIA driver 570.211.01, 2x RTX 6000 Ada 48GB.
- Existing LLaDA: GPU0, user service llada-image-api, loopback port 8190.
- Existing IndexTTS: GPU1, about 8600 MiB resident; preserved without restart.
- Qwen: separate `/data/apps/qwen-image-21-eval`, GPU1 only, loopback port 8191.
- BF16 model CPU offload; PyTorch allocator capped at 58% of GPU memory; thermal guard stops at 85C.
- New service is private and for research/evaluation under the Qwen Research License.
- Gateway/R760 is not changed. Read-only R760 preflight encountered an existing NVML driver/library mismatch.

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
