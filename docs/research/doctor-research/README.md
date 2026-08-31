# Doctor Research

Last updated: 2026-08-31.

Doctor Research is the asynchronous doctor-profile research capability hosted
inside the authoritative R760 Gateway deployment. The former Azure Research
stack is retired from routine use and is not a compatibility or rollback path.

## Current Boundary

- Public origin: `https://goldencode.instmarket.com.au:1443`
- API prefix: `/gateway/research/v1`
- Authentication: real-user `cgu_live_*` credential with an active
  `doctor_research` entitlement
- Runtime: public Gateway, isolated Research LLM Gateway, Worker and
  maintenance service in Compose project `codex_gateway_r760`
- Research LLM: isolated `goldencode` profile; do not route through the public
  Gateway pool or GoldenCode Local
- State/artifacts/backups: dedicated Research volumes, not the ordinary Gateway
  request/client-message databases

## Choose One Document

- Client API and examples: [API Usage](./api-usage.zh-CN.md)
- Production operations: [Production Runbook](./production-runbook.md)
- Current known state: [Current Status](./current-status-problems-and-remediation.md)
- Original architecture: [Azure Service Design](./api-service-design.md) —
  historical design record only
- Dated reports in this directory: implementation/incident evidence, not
  current runbooks

Do not read the complete historical bundle for a normal status check or client
question.

## Core Product Contract

Clients create an asynchronous run with an idempotency key, poll status, handle
identity selection when requested, then retrieve the result manifest and
artifacts. Runs and artifacts are isolated by subject. Do not infer access from
a key prefix; the active entitlement is required.

The input contains only the doctor's name, hospital and department. Public
identity discovery may require user confirmation and may fail when evidence is
insufficient or conflicting. The service must not fabricate identity,
publications or research directions.

## Safety

- Never place credentials, patient data, private records or full copyrighted
  sources in requests, logs or artifacts.
- Preserve source URLs, citations, provenance and warnings.
- Do not publish Research internal services or raw model ports.
- Do not print secret/env files or rendered Compose config.
- Do not operate Research by starting the retired Azure stack.
- Treat detailed medical content acceptance as a separate domain review from
  infrastructure health.
