#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const severityRank = { warning: 1, critical: 2, emergency: 3 };

export function evaluateWatchdog(input) {
  if (!input || input.schemaVersion !== 1) {
    throw new Error("watchdog input must use schemaVersion=1");
  }
  const now = parseDate(input.generatedAt) ?? new Date();
  const previousState = readPrevious(input)?.state ?? {};
  const previousConditions = previousState.conditions ?? {};
  const conditions = {};
  const findings = [];

  const observe = ({
    key,
    severity,
    summary,
    value = null,
    threshold = null,
    minSamples = 1,
    escalatedSeverity = null,
    escalateAfterSamples = null
  }) => {
    const prior = previousConditions[key];
    const preserveCount = escalatedSeverity !== null;
    const count = prior && (preserveCount || prior.severity === severity)
      ? number(prior.count, 0) + 1
      : 1;
    const effectiveSeverity = escalatedSeverity && count >= escalateAfterSamples
      ? escalatedSeverity
      : severity;
    conditions[key] = {
      severity: effectiveSeverity,
      count,
      firstObservedAt: prior && (preserveCount || prior.severity === severity)
        ? prior.firstObservedAt
        : now.toISOString(),
      lastObservedAt: now.toISOString()
    };
    if (count >= minSamples) {
      findings.push({ key, severity: effectiveSeverity, summary, value, threshold });
    }
  };

  evaluateGatewayHealth(input.gatewayHealth, observe);
  evaluateHost(input.host, observe);
  evaluateContainer(input.container, observe);
  evaluateTemporaryState(input.temporaryState, input.container, observe);
  evaluateOperations(input.ops, observe);

  const history = nextMetricHistory(previousState.metricHistory, input, now);
  evaluateGrowth(history, observe);

  findings.sort(compareFindings);
  const previousActive = previousState.active ?? {};
  const active = {};
  const events = { new: [], escalated: [], ongoing: [], resolved: [] };
  for (const finding of findings) {
    const prior = previousActive[finding.key];
    active[finding.key] = {
      severity: finding.severity,
      firstSeenAt: prior?.firstSeenAt ?? now.toISOString(),
      lastSeenAt: now.toISOString(),
      occurrences: number(prior?.occurrences, 0) + 1,
      summary: finding.summary
    };
    if (!prior) {
      events.new.push(finding);
    } else if (severityRank[finding.severity] > severityRank[prior.severity]) {
      events.escalated.push(finding);
    } else {
      events.ongoing.push(finding);
    }
  }
  for (const [key, prior] of Object.entries(previousActive)) {
    if (!active[key]) {
      events.resolved.push({
        key,
        severity: prior.severity,
        summary: prior.summary,
        resolvedAt: now.toISOString()
      });
    }
  }

  const highestSeverity = findings.reduce(
    (highest, finding) =>
      !highest || severityRank[finding.severity] > severityRank[highest]
        ? finding.severity
        : highest,
    null
  );

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    mode: "no-notify",
    status: highestSeverity ?? "ok",
    findings,
    events,
    state: { active, conditions, metricHistory: history }
  };
}

function evaluateGatewayHealth(health, observe) {
  if (!health || health.status === "unavailable") {
    observe({
      key: "gateway.health_collection",
      severity: "warning",
      summary: "Gateway health collection is unavailable",
      minSamples: 2
    });
    return;
  }
  if (health.httpStatus !== 200 || health.ready !== true) {
    observe({
      key: "gateway.health",
      severity: health.httpStatus === 0 ? "critical" : "warning",
      summary: "Gateway health check is not ready",
      value: health.httpStatus,
      threshold: 200,
      minSamples: 1,
      escalatedSeverity: health.httpStatus === 0 ? null : "critical",
      escalateAfterSamples: health.httpStatus === 0 ? null : 2
    });
  }
}

function evaluateHost(host, observe) {
  if (!host) {
    observe({
      key: "host.collection",
      severity: "warning",
      summary: "Host metrics collection is unavailable",
      minSamples: 2
    });
    return;
  }
  const available = number(host.memAvailableBytes, Infinity);
  if (available < 750 * MiB) {
    observe({ key: "host.memory_available", severity: "emergency", summary: "Host available memory is below 750 MiB", value: available, threshold: 750 * MiB });
  } else if (available < 1.5 * GiB) {
    observe({ key: "host.memory_available", severity: "critical", summary: "Host available memory is below 1.5 GiB", value: available, threshold: 1.5 * GiB, minSamples: 2 });
  } else if (available < 3 * GiB) {
    observe({ key: "host.memory_available", severity: "warning", summary: "Host available memory is below 3 GiB", value: available, threshold: 3 * GiB, minSamples: 5 });
  }

  if (host.memoryPsiSupported === false) {
    observe({ key: "host.memory_psi_unsupported", severity: "warning", summary: "Host memory PSI is unsupported", minSamples: 2 });
  } else {
    const full = number(host.memoryPsiFullAvg60, 0);
    const some = number(host.memoryPsiSomeAvg60, 0);
    if (full > 10) {
      observe({ key: "host.memory_psi", severity: "emergency", summary: "Host full memory PSI exceeds 10%", value: full, threshold: 10 });
    } else if (some > 25) {
      observe({ key: "host.memory_psi", severity: "critical", summary: "Host memory PSI exceeds 25%", value: some, threshold: 25, minSamples: 2 });
    } else if (some > 10) {
      observe({ key: "host.memory_psi", severity: "warning", summary: "Host memory PSI exceeds 10%", value: some, threshold: 10, minSamples: 5 });
    }
  }

  const diskUsed = number(host.diskUsedPercent, 0);
  const diskAvailable = number(host.diskAvailableBytes, Infinity);
  if (diskUsed >= 92 || diskAvailable <= 6 * GiB) {
    observe({ key: "host.root_disk", severity: "emergency", summary: "Host root disk is near exhaustion", value: { usedPercent: diskUsed, availableBytes: diskAvailable }, threshold: { usedPercent: 92, availableBytes: 6 * GiB } });
  } else if (diskUsed >= 85 || diskAvailable <= 12 * GiB) {
    observe({ key: "host.root_disk", severity: "critical", summary: "Host root disk is critically constrained", value: { usedPercent: diskUsed, availableBytes: diskAvailable }, threshold: { usedPercent: 85, availableBytes: 12 * GiB } });
  } else if (diskUsed >= 75 || diskAvailable <= 25 * GiB) {
    observe({ key: "host.root_disk", severity: "warning", summary: "Host root disk is approaching capacity", value: { usedPercent: diskUsed, availableBytes: diskAvailable }, threshold: { usedPercent: 75, availableBytes: 25 * GiB } });
  }

  const inodeUsed = number(host.inodeUsedPercent, 0);
  if (inodeUsed >= 92) {
    observe({ key: "host.inodes", severity: "emergency", summary: "Host inode usage exceeds 92%", value: inodeUsed, threshold: 92 });
  } else if (inodeUsed >= 85) {
    observe({ key: "host.inodes", severity: "critical", summary: "Host inode usage exceeds 85%", value: inodeUsed, threshold: 85 });
  } else if (inodeUsed >= 75) {
    observe({ key: "host.inodes", severity: "warning", summary: "Host inode usage exceeds 75%", value: inodeUsed, threshold: 75 });
  }

  const load = number(host.load1, 0);
  const vcpus = Math.max(1, number(host.vcpus, 1));
  if (load > 2 * vcpus) {
    observe({ key: "host.load", severity: "critical", summary: "Host load exceeds twice the vCPU count", value: load, threshold: 2 * vcpus, minSamples: 5 });
  } else if (load > vcpus) {
    observe({ key: "host.load", severity: "warning", summary: "Host load exceeds the vCPU count", value: load, threshold: vcpus, minSamples: 10 });
  }
}

function evaluateContainer(container, observe) {
  if (!container || container.status === "unavailable") {
    observe({ key: "container.collection", severity: "warning", summary: "Gateway container inspection is unavailable", minSamples: 2 });
    return;
  }
  if (container.health !== "healthy") {
    observe({
      key: "container.health",
      severity: "warning",
      summary: "Gateway container is not healthy",
      value: container.health,
      threshold: "healthy",
      minSamples: 1,
      escalatedSeverity: "critical",
      escalateAfterSamples: 2
    });
  }
  if (container.oomKilled === true) {
    observe({ key: "container.oom", severity: "emergency", summary: "Gateway container was OOM-killed" });
  }
  const memory = number(container.memoryBytes, 0);
  if (memory >= 5.8 * GiB) {
    observe({ key: "container.memory", severity: "emergency", summary: "Gateway container memory exceeds 5.8 GiB", value: memory, threshold: 5.8 * GiB });
  } else if (memory >= 5.4 * GiB) {
    observe({ key: "container.memory", severity: "critical", summary: "Gateway container memory exceeds 5.4 GiB", value: memory, threshold: 5.4 * GiB });
  } else if (memory >= 4.5 * GiB) {
    observe({ key: "container.memory", severity: "warning", summary: "Gateway container memory exceeds 4.5 GiB", value: memory, threshold: 4.5 * GiB, minSamples: 2 });
  }
  const pids = number(container.pids, 0);
  if (pids >= 245) {
    observe({ key: "container.pids", severity: "emergency", summary: "Gateway container PID usage exceeds 245", value: pids, threshold: 245 });
  } else if (pids >= 230) {
    observe({ key: "container.pids", severity: "critical", summary: "Gateway container PID usage exceeds 230", value: pids, threshold: 230 });
  } else if (pids >= 200) {
    observe({ key: "container.pids", severity: "warning", summary: "Gateway container PID usage exceeds 200", value: pids, threshold: 200 });
  }
  const codexChildren = number(container.codexChildren, 0);
  const allowed = Math.max(1, number(container.allowedCodexConcurrency, 4));
  if (codexChildren > 2 * allowed) {
    observe({ key: "container.codex_children", severity: "critical", summary: "Codex child process count exceeds twice the allowed concurrency", value: codexChildren, threshold: 2 * allowed });
  } else if (codexChildren > allowed + 2) {
    observe({ key: "container.codex_children", severity: "warning", summary: "Codex child process count exceeds allowed concurrency plus two", value: codexChildren, threshold: allowed + 2 });
  }
}

function evaluateTemporaryState(temporaryState, container, observe) {
  if (!temporaryState || temporaryState.status !== "ok") {
    observe({
      key: "container.temporary_state_collection",
      severity: container?.health && container.health !== "healthy" ? "critical" : "warning",
      summary: "Temporary Codex state collection is unavailable",
      minSamples: 2
    });
    return;
  }
  const largest = number(temporaryState.largestBytes, 0);
  const total = number(temporaryState.totalBytes, 0);
  const oldest = number(temporaryState.oldestAgeSeconds, 0);
  if (largest > 512 * MiB) {
    observe({ key: "container.temporary_state_largest", severity: "critical", summary: "A request temporary state directory exceeds 512 MiB", value: largest, threshold: 512 * MiB });
  } else if (largest > 128 * MiB) {
    observe({ key: "container.temporary_state_largest", severity: "warning", summary: "A request temporary state directory exceeds 128 MiB", value: largest, threshold: 128 * MiB });
  }
  if (total > 3 * GiB) {
    observe({ key: "container.temporary_state_total", severity: "emergency", summary: "Temporary request state exceeds 3 GiB", value: total, threshold: 3 * GiB });
  } else if (total > GiB) {
    observe({ key: "container.temporary_state_total", severity: "critical", summary: "Temporary request state exceeds 1 GiB", value: total, threshold: GiB });
  } else if (total > 256 * MiB) {
    observe({ key: "container.temporary_state_total", severity: "warning", summary: "Temporary request state exceeds 256 MiB", value: total, threshold: 256 * MiB });
  }
  if (number(temporaryState.count, 0) > 0 && oldest > 1_800) {
    observe({ key: "container.temporary_state_age", severity: "critical", summary: "Temporary request state is older than 30 minutes", value: oldest, threshold: 1_800 });
  } else if (number(temporaryState.count, 0) > 0 && oldest > 600) {
    observe({ key: "container.temporary_state_age", severity: "warning", summary: "Temporary request state is older than 10 minutes", value: oldest, threshold: 600 });
  }
}

function evaluateOperations(ops, observe) {
  if (!ops) {
    observe({ key: "gateway.ops_snapshot", severity: "warning", summary: "Gateway operations snapshot is unavailable", minSamples: 2 });
    return;
  }
  if (ops.runtimeSnapshotStatus !== "ok") {
    observe({ key: "gateway.runtime_snapshot", severity: "warning", summary: "Gateway runtime snapshot is unavailable", value: ops.runtimeSnapshotStatus, threshold: "ok", minSamples: 2 });
  }
  const runtime = ops.runtime ?? {};
  const oldestInflight = number(runtime.oldestInflightAgeSeconds, 0);
  if (oldestInflight > 600) {
    observe({ key: "gateway.oldest_inflight", severity: "critical", summary: "A Gateway request has been active for more than 600 seconds", value: oldestInflight, threshold: 600 });
  } else if (oldestInflight > 300) {
    observe({ key: "gateway.oldest_inflight", severity: "warning", summary: "A Gateway request has been active for more than 300 seconds", value: oldestInflight, threshold: 300 });
  }
  if (number(runtime.deadlineExceededRequests, 0) > 0 && number(runtime.oldestDeadlineExceededAgeSeconds, 0) > 30) {
    observe({ key: "gateway.deadline_residue", severity: "emergency", summary: "A request remains active more than 30 seconds after its deadline", value: runtime.oldestDeadlineExceededAgeSeconds, threshold: 30 });
  }

  const window5 = ops.windows?.["5m"] ?? {};
  const window15 = ops.windows?.["15m"] ?? {};
  const total5 = number(window5.total, 0);
  const infra5 = number(window5.infrastructureErrors, 0);
  const infraUsers5 = number(window5.infrastructureAffectedUsers, 0);
  const infraRate5 = total5 > 0 ? infra5 / total5 : 0;
  if (total5 >= 5 && (infraRate5 >= 0.4 || infra5 >= 5 || infraUsers5 >= 3)) {
    observe({ key: "gateway.infrastructure_errors", severity: "critical", summary: "Gateway infrastructure errors are elevated", value: { total: total5, errors: infra5, affectedUsers: infraUsers5 }, threshold: { rate: 0.4, errors: 5, affectedUsers: 3 } });
  } else if (total5 >= 5 && (infraRate5 >= 0.2 || infra5 >= 3)) {
    observe({ key: "gateway.infrastructure_errors", severity: "warning", summary: "Gateway infrastructure errors are above warning threshold", value: { total: total5, errors: infra5 }, threshold: { rate: 0.2, errors: 3 } });
  }
  if (number(window5.rateLimitOriginUnknown, 0) > 0) {
    observe({ key: "gateway.rate_limit_origin_unknown", severity: "warning", summary: "One or more rate-limit events have an unknown origin", value: window5.rateLimitOriginUnknown, threshold: 0 });
  }
  if (number(window5.upstreamRateLimited, 0) >= 3) {
    observe({ key: "gateway.upstream_rate_limited", severity: "warning", summary: "Upstream rate limiting occurred at least three times in five minutes", value: window5.upstreamRateLimited, threshold: 3 });
  }

  const p95FirstByte = number(window15.p95FirstByteMs, 0);
  if (p95FirstByte > 300_000 || number(window15.firstByteOver300Seconds, 0) >= 3) {
    observe({ key: "gateway.first_byte_latency", severity: "critical", summary: "Gateway first-byte latency is critically elevated", value: p95FirstByte, threshold: 300_000 });
  } else if (number(window15.total, 0) >= 5 && p95FirstByte > 120_000) {
    observe({ key: "gateway.first_byte_latency", severity: "warning", summary: "Gateway first-byte p95 exceeds 120 seconds", value: p95FirstByte, threshold: 120_000 });
  }
  const p95Duration = number(window15.p95DurationMs, 0);
  if (p95Duration > 600_000 || number(window15.durationOver600Seconds, 0) > 0) {
    observe({ key: "gateway.total_latency", severity: "critical", summary: "Gateway total request latency is critically elevated", value: p95Duration, threshold: 600_000 });
  } else if (number(window15.total, 0) >= 5 && p95Duration > 300_000) {
    observe({ key: "gateway.total_latency", severity: "warning", summary: "Gateway total request p95 exceeds 300 seconds", value: p95Duration, threshold: 300_000 });
  }

  for (const account of ops.upstreamAccounts ?? []) {
    if (account.state === "reauth_required") {
      observe({ key: `upstream.${safeId(account.id)}.reauth`, severity: "critical", summary: `Upstream account ${safeId(account.id)} requires reauthentication` });
    } else if (account.state === "cooldown" || account.cooldownUntil) {
      observe({ key: `upstream.${safeId(account.id)}.cooldown`, severity: "warning", summary: `Upstream account ${safeId(account.id)} is in cooldown` });
    }
  }
}

function nextMetricHistory(previous, input, now) {
  const cutoff = now.getTime() - 26 * 60 * 60 * 1_000;
  const retained = Array.isArray(previous)
    ? previous.filter((sample) => (parseDate(sample.at)?.getTime() ?? 0) >= cutoff)
    : [];
  retained.push({
    at: now.toISOString(),
    diskUsedBytes: number(input.host?.diskUsedBytes, 0),
    persistentStateBytes: persistentStateBytes(input.persistentState),
    quarantineBytes: number(input.persistentState?.quarantineBytes, 0),
    restartCount: number(input.container?.restartCount, 0)
  });
  return retained.slice(-1_600);
}

function evaluateGrowth(history, observe) {
  const current = history.at(-1);
  if (!current) return;
  const immediatelyPrior = history.at(-2);
  const tenMinute = closestPrior(history, current.at, 8 * 60_000, 12 * 60_000);
  const recentRestartGrowth = immediatelyPrior
    ? current.restartCount - immediatelyPrior.restartCount
    : 0;
  const windowRestartGrowth = tenMinute
    ? current.restartCount - tenMinute.restartCount
    : 0;
  if (windowRestartGrowth >= 2) {
    observe({ key: "container.restarts", severity: "critical", summary: "Gateway container restarted at least twice in about 10 minutes", value: windowRestartGrowth, threshold: 2 });
  } else if (recentRestartGrowth > 0) {
    observe({ key: "container.restarts", severity: "warning", summary: "Gateway container restart count increased", value: recentRestartGrowth, threshold: 0 });
  }
  if (tenMinute) {
    const diskGrowth = current.diskUsedBytes - tenMinute.diskUsedBytes;
    if (diskGrowth > 8 * GiB) {
      observe({ key: "host.disk_growth", severity: "emergency", summary: "Host disk grew by more than 8 GiB in about 10 minutes", value: diskGrowth, threshold: 8 * GiB });
    } else if (diskGrowth > 5 * GiB) {
      observe({ key: "host.disk_growth", severity: "critical", summary: "Host disk grew by more than 5 GiB in about 10 minutes", value: diskGrowth, threshold: 5 * GiB });
    } else if (diskGrowth > 2 * GiB) {
      observe({ key: "host.disk_growth", severity: "warning", summary: "Host disk grew by more than 2 GiB in about 10 minutes", value: diskGrowth, threshold: 2 * GiB });
    }
    const stateGrowth = current.persistentStateBytes - tenMinute.persistentStateBytes;
    if (stateGrowth > 512 * MiB) {
      observe({ key: "gateway.sqlite_growth", severity: "critical", summary: "Persistent Codex SQLite state grew by more than 512 MiB in about 10 minutes", value: stateGrowth, threshold: 512 * MiB });
    } else if (stateGrowth > 128 * MiB) {
      observe({ key: "gateway.sqlite_growth", severity: "warning", summary: "Persistent Codex SQLite state grew by more than 128 MiB in about 10 minutes", value: stateGrowth, threshold: 128 * MiB });
    }
  }
  const daily = closestPrior(history, current.at, 20 * 60 * 60_000, 26 * 60 * 60_000);
  if (daily && current.quarantineBytes - daily.quarantineBytes > 2 * GiB) {
    observe({ key: "gateway.rollout_quarantine_growth", severity: "warning", summary: "Rollout quarantine grew by more than 2 GiB in a day", value: current.quarantineBytes - daily.quarantineBytes, threshold: 2 * GiB });
  }
}

function closestPrior(history, currentAt, minimumAgeMs, maximumAgeMs) {
  const currentMs = parseDate(currentAt)?.getTime() ?? 0;
  let match = null;
  let bestDistance = Infinity;
  for (const sample of history.slice(0, -1)) {
    const sampleMs = parseDate(sample.at)?.getTime() ?? 0;
    const age = currentMs - sampleMs;
    if (age < minimumAgeMs || age > maximumAgeMs) continue;
    const distance = Math.abs(age - (minimumAgeMs + maximumAgeMs) / 2);
    if (distance < bestDistance) {
      bestDistance = distance;
      match = sample;
    }
  }
  return match;
}

function persistentStateBytes(value) {
  if (!value) return 0;
  return ["primaryDbBytes", "primaryWalBytes", "plusDbBytes", "plusWalBytes"]
    .map((key) => number(value[key], 0))
    .reduce((sum, item) => sum + item, 0);
}

function compareFindings(left, right) {
  return severityRank[right.severity] - severityRank[left.severity] || left.key.localeCompare(right.key);
}

function number(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseDate(value) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function safeId(value) {
  return String(value ?? "unknown").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
}

function readPrevious(input) {
  if (input.previous && typeof input.previous === "object") {
    return input.previous;
  }
  if (typeof input.previousBase64 !== "string" || input.previousBase64.length === 0) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(input.previousBase64, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

async function readStdin() {
  let value = "";
  for await (const chunk of process.stdin) value += chunk;
  return value;
}

async function main() {
  const inputIndex = process.argv.indexOf("--input");
  const inputPath = inputIndex >= 0 ? process.argv[inputIndex + 1] : "-";
  if (!inputPath) throw new Error("--input requires a path or -");
  const raw = inputPath === "-" ? await readStdin() : readFileSync(inputPath, "utf8");
  process.stdout.write(`${JSON.stringify(evaluateWatchdog(JSON.parse(raw)), null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`watchdog_error=${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
