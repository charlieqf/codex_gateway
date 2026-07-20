import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  realpath,
  rm
} from "node:fs/promises";
import path from "node:path";
import type { ResearchMaintenanceLockName } from "@codex-gateway/core";
import {
  createResearchBackupSnapshot,
  deleteResearchArtifactFiles,
  executeDoctorResearchWorkflow,
  GatewayResearchModelClient,
  getDefaultMedicalSkillBundle,
  LiveResearchAdapters,
  probeResearchStorageAdmission,
  recoverOrphanResearchArtifacts,
  ResearchMaintenanceGate,
  runWithResearchLeaseGuard,
  verifyResearchBackupSnapshot,
  fetchBoundedJson,
  type ResearchAdapterBundle,
  type MedicalSkillBundle,
  type ResearchModelClient
} from "@codex-gateway/research-agent";
import {
  createResearchSqliteStore,
  type ResearchSqliteStore
} from "@codex-gateway/store-sqlite";
import {
  type ResearchWorkerConfig,
  readSecretFile
} from "./config.js";

export interface ResearchWorkerLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface ResearchWorkerDependencies {
  adapters: ResearchAdapterBundle & {
    assertAvailable(signal: AbortSignal): Promise<void>;
  };
  modelClient: ResearchModelClient & {
    assertModelAvailable(signal: AbortSignal): Promise<void>;
  };
  medicalSkillBundle?: MedicalSkillBundle;
}

export async function runResearchWorker(input: {
  config: ResearchWorkerConfig;
  signal: AbortSignal;
  logger: ResearchWorkerLogger;
  fetchImpl?: typeof fetch;
  dependencies?: ResearchWorkerDependencies;
}): Promise<void> {
  const { config, logger } = input;
  const lifecycleController = new AbortController();
  const workerSignal = AbortSignal.any([
    input.signal,
    lifecycleController.signal
  ]);
  await mkdir(config.artifactRoot, { recursive: true, mode: 0o700 });
  await mkdir(config.backupRoot, { recursive: true, mode: 0o700 });
  await assertCanonicalRuntimeStorage(config);
  const store = createResearchSqliteStore({
    path: config.databasePath,
    limits: config.admissionLimits,
    ...config.store,
    logger: {
      info(message) {
        logger.info("research_store", { message });
      }
    }
  });
  const processInstanceId = `drw_${randomUUID().replaceAll("-", "")}`;
  const startedAt = new Date();
  const timers: NodeJS.Timeout[] = [];
  const reconciliationGate = new ResearchMaintenanceGate();
  const cleanupGate = new ResearchMaintenanceGate();
  const backupGate = new ResearchMaintenanceGate();
  let state: "starting" | "ready" | "draining" = "starting";
  let nextStorageProbeAt = 0;
  let fatalDependencyError: Error | null = null;
  const stopForDependencyFailure = () => {
    if (fatalDependencyError) {
      return;
    }
    fatalDependencyError = new Error(
      "Research Worker dependencies remained unavailable after retry."
    );
    state = "draining";
    try {
      heartbeat(store, config, processInstanceId, startedAt, state);
    } catch {
      // The outer shutdown path remains fail-closed if the database is lost.
    }
    lifecycleController.abort(fatalDependencyError);
  };
  try {
    if (
      heartbeat(store, config, processInstanceId, startedAt, state) ===
      "stale_process_ignored"
    ) {
      throw new Error(
        "Research Worker process instance was superseded before startup."
      );
    }
    const dependencies =
      input.dependencies ??
      (await createLiveDependencies(config, input.fetchImpl));
    const { adapters, modelClient } = dependencies;
    const medicalSkillBundle =
      dependencies.medicalSkillBundle ??
      getDefaultMedicalSkillBundle();
    logger.info("research_medical_skill_bundle_loaded", {
      bundle_sha256: medicalSkillBundle.digest,
      document_count: medicalSkillBundle.documents.length
    });
    await adapters.assertAvailable(workerSignal);
    await modelClient.assertModelAvailable(workerSignal);
    if (config.embeddedMaintenanceEnabled) {
      await withDatabaseMaintenanceLock({
        store,
        name: "reconcile",
        owner: processInstanceId,
        required: true,
        signal: workerSignal,
        operation: () => runReconciliation(store, config)
      });
      await withDatabaseMaintenanceLock({
        store,
        name: "cleanup",
        owner: processInstanceId,
        required: true,
        signal: workerSignal,
        operation: () => runCleanup(store, config)
      });
    } else {
      assertBackupFresh(store, config);
    }
    await assertStorageAvailable(config);
    nextStorageProbeAt = Date.now() + config.heartbeatSeconds * 1_000;
    if (config.embeddedMaintenanceEnabled) {
      await withBackupMaintenanceLocks({
        store,
        owner: processInstanceId,
        required: true,
        signal: workerSignal,
        operation: () => runBackup(store, config, logger)
      });
    }
    state = "ready";
    if (
      heartbeat(store, config, processInstanceId, startedAt, state) ===
      "stale_process_ignored"
    ) {
      throw new Error(
        "Research Worker process instance was superseded during startup."
      );
    }

    timers.push(
      recurring(
        config.heartbeatSeconds * 1_000,
        () => {
          const outcome = heartbeat(
            store,
            config,
            processInstanceId,
            startedAt,
            state
          );
          if (outcome === "stale_process_ignored") {
            logger.error("research_worker_superseded", {
              worker_id: config.workerId,
              process_instance_id: processInstanceId
            });
            lifecycleController.abort(
              new Error("Research Worker process instance was superseded.")
            );
          }
        },
        logger,
        "heartbeat"
      )
    );
    if (config.embeddedMaintenanceEnabled) {
      timers.push(
        recurring(
          config.reconcileIntervalSeconds * 1_000,
          () =>
            reconciliationGate.run(() =>
              withDatabaseMaintenanceLock({
                store,
                name: "reconcile",
                owner: processInstanceId,
                required: false,
                signal: workerSignal,
                operation: () => runReconciliation(store, config)
              })
            ),
          logger,
          "reconciliation"
        ),
        recurring(
          config.cleanupIntervalSeconds * 1_000,
          () =>
            cleanupGate.run(() =>
              withDatabaseMaintenanceLock({
                store,
                name: "cleanup",
                owner: processInstanceId,
                required: false,
                signal: workerSignal,
                operation: () => runCleanup(store, config)
              })
            ),
          logger,
          "cleanup"
        ),
        recurring(
          config.backupIntervalSeconds * 1_000,
          () =>
            backupGate.run(() =>
              withBackupMaintenanceLocks({
                store,
                owner: processInstanceId,
                required: false,
                signal: workerSignal,
                operation: () => runBackup(store, config, logger)
              })
            ),
          logger,
          "backup"
        )
      );
    }
    logger.info("research_worker_ready", {
      worker_id: config.workerId,
      process_instance_id: processInstanceId,
      version: config.processVersion
    });

    while (!workerSignal.aborted) {
      if (Date.now() >= nextStorageProbeAt) {
        try {
          await assertStorageAvailable(config);
          nextStorageProbeAt = Date.now() + config.heartbeatSeconds * 1_000;
        } catch (error) {
          logger.error("research_storage_unavailable", {
            error_type: error instanceof Error ? error.name : "unknown"
          });
          nextStorageProbeAt = Date.now() + config.pollIntervalMs;
          await delay(config.pollIntervalMs, workerSignal);
          continue;
        }
      }
      const lease = store.acquireLease({
        workerId: config.workerId,
        leaseSeconds: config.leaseSeconds
      });
      if (!lease) {
        await delay(config.pollIntervalMs, workerSignal);
        continue;
      }
      logger.info("research_lease_acquired", {
        run_id: lease.run.runId,
        lease_generation: lease.token.generation,
        attempt: lease.run.attemptCount
      });
      if (lease.cancelRequested) {
        store.completeCancellation({ token: lease.token });
        continue;
      }
      let currentToken = lease.token;
      try {
        const guarded = await runWithResearchLeaseGuard({
          renewalIntervalMs: config.leaseRenewSeconds * 1_000,
          abortSettleTimeoutMs: config.drainTimeoutMs,
          signal: workerSignal,
          renew: () => {
            const renewed = store.renewLease({
              token: currentToken,
              leaseSeconds: config.leaseSeconds
            });
            if (renewed.outcome === "lost") {
              return { outcome: "lease_lost" as const };
            }
            currentToken = renewed.token;
            return renewed.cancelRequested
              ? { outcome: "cancel_requested" as const }
              : { outcome: "continue" as const };
          },
          operation: (signal) =>
            executeDoctorResearchWorkflow({
              lease: { ...lease, token: currentToken },
              store,
              adapters,
              modelClient,
              artifactRoot: config.artifactRoot,
              policy: config.workflowPolicy,
              medicalSkillBundle,
              signal,
              onValidationFailure(event) {
                logger.info("research_model_validation_failed", {
                  run_id: event.runId,
                  lease_generation: currentToken.generation,
                  stage: event.stage,
                  attempt: event.attempt,
                  error_codes: event.errorCodes
                });
              }
            })
        });
        if (guarded.outcome !== "completed") {
          if (guarded.outcome === "cancel_requested") {
            store.completeCancellation({ token: currentToken });
          } else if (workerSignal.aborted) {
            store.requeueRun({
              token: currentToken,
              reason: "worker_draining"
            });
          }
          continue;
        }
        const workflow = guarded.value;
        if (workflow.outcome === "fenced_or_cancelled") {
          convergeCancellation(store, currentToken, config.leaseSeconds);
        } else if (workflow.outcome === "failed") {
          if (
            workflow.reason === "upstream_unavailable" &&
            workflow.retryable === true &&
            lease.run.attemptCount < 2
          ) {
            store.requeueRun({
              token: currentToken,
              reason: "retriable_upstream_failure"
            });
          } else {
            const failed = store.failRun({
              token: currentToken,
              terminalReason: workflow.reason
            });
            if (failed.outcome === "fenced_or_cancelled") {
              convergeCancellation(store, currentToken, config.leaseSeconds);
            } else if (workflow.reason === "upstream_unavailable") {
              stopForDependencyFailure();
            }
          }
        }
      } catch (error) {
        logger.error("research_run_exception", {
          run_id: lease.run.runId,
          lease_generation: currentToken.generation,
          error_type: error instanceof Error ? error.name : "unknown"
        });
        if (workerSignal.aborted) {
          store.requeueRun({
            token: currentToken,
            reason: "worker_draining"
          });
        } else {
          const failed = store.failRun({
            token: currentToken,
            terminalReason: "upstream_unavailable"
          });
          if (failed.outcome === "failed") {
            stopForDependencyFailure();
          } else {
            convergeCancellation(
              store,
              currentToken,
              config.leaseSeconds
            );
          }
        }
      }
    }
    if (fatalDependencyError) {
      throw fatalDependencyError;
    }
  } finally {
    state = "draining";
    try {
      heartbeat(store, config, processInstanceId, startedAt, state);
    } catch {
      // Shutdown remains best effort after the database has become unavailable.
    }
    for (const timer of timers) {
      clearInterval(timer);
    }
    await Promise.allSettled([
      reconciliationGate.waitForIdle(),
      cleanupGate.waitForIdle(),
      backupGate.waitForIdle()
    ]);
    store.close();
    logger.info("research_worker_stopped", {
      worker_id: config.workerId,
      process_instance_id: processInstanceId
    });
  }
}

export async function runResearchMaintenance(input: {
  config: ResearchWorkerConfig;
  signal: AbortSignal;
  logger: ResearchWorkerLogger;
}): Promise<void> {
  const { config, logger } = input;
  const lifecycleController = new AbortController();
  const maintenanceSignal = AbortSignal.any([
    input.signal,
    lifecycleController.signal
  ]);
  await mkdir(config.artifactRoot, { recursive: true, mode: 0o700 });
  await mkdir(config.backupRoot, { recursive: true, mode: 0o700 });
  await assertCanonicalRuntimeStorage(config);
  const store = createResearchSqliteStore({
    path: config.databasePath,
    limits: config.admissionLimits,
    ...config.store,
    logger: {
      info(message) {
        logger.info("research_maintenance_store", { message });
      }
    }
  });
  const processInstanceId = `drm_${randomUUID().replaceAll("-", "")}`;
  const reconciliationGate = new ResearchMaintenanceGate();
  const cleanupGate = new ResearchMaintenanceGate();
  const backupGate = new ResearchMaintenanceGate();
  const timers: NodeJS.Timeout[] = [];
  let fatalError: unknown;
  const fail = (error: unknown) => {
    if (fatalError !== undefined) {
      return;
    }
    fatalError = error;
    lifecycleController.abort(
      error instanceof Error
        ? error
        : new Error("Research maintenance failed.")
    );
  };
  try {
    await withDatabaseMaintenanceLock({
      store,
      name: "reconcile",
      owner: processInstanceId,
      required: true,
      signal: maintenanceSignal,
      operation: () => runReconciliation(store, config)
    });
    await withDatabaseMaintenanceLock({
      store,
      name: "cleanup",
      owner: processInstanceId,
      required: true,
      signal: maintenanceSignal,
      operation: () => runCleanup(store, config)
    });
    await assertStorageAvailable(config);
    await withBackupMaintenanceLocks({
      store,
      owner: processInstanceId,
      required: true,
      signal: maintenanceSignal,
      operation: () => runBackup(store, config, logger)
    });
    timers.push(
      recurring(
        config.reconcileIntervalSeconds * 1_000,
        () =>
          reconciliationGate.run(() =>
            withDatabaseMaintenanceLock({
              store,
              name: "reconcile",
              owner: processInstanceId,
              required: false,
              signal: maintenanceSignal,
              operation: () => runReconciliation(store, config)
            })
          ),
        logger,
        "maintenance_reconciliation",
        fail
      ),
      recurring(
        config.cleanupIntervalSeconds * 1_000,
        () =>
          cleanupGate.run(() =>
            withDatabaseMaintenanceLock({
              store,
              name: "cleanup",
              owner: processInstanceId,
              required: false,
              signal: maintenanceSignal,
              operation: () => runCleanup(store, config)
            })
          ),
        logger,
        "maintenance_cleanup",
        fail
      ),
      recurring(
        config.backupIntervalSeconds * 1_000,
        () =>
          backupGate.run(() =>
            withBackupMaintenanceLocks({
              store,
              owner: processInstanceId,
              required: false,
              signal: maintenanceSignal,
              operation: () => runBackup(store, config, logger)
            })
          ),
        logger,
        "maintenance_backup",
        fail
      )
    );
    logger.info("research_maintenance_ready", {
      process_instance_id: processInstanceId,
      version: config.processVersion
    });
    await waitForAbort(maintenanceSignal);
    if (fatalError !== undefined) {
      throw fatalError;
    }
  } finally {
    for (const timer of timers) {
      clearInterval(timer);
    }
    await Promise.allSettled([
      reconciliationGate.waitForIdle(),
      cleanupGate.waitForIdle(),
      backupGate.waitForIdle()
    ]);
    store.close();
    logger.info("research_maintenance_stopped", {
      process_instance_id: processInstanceId
    });
  }
}

async function assertCanonicalRuntimeStorage(
  config: ResearchWorkerConfig
): Promise<void> {
  for (const directory of [
    path.dirname(config.databasePath),
    config.artifactRoot,
    config.backupRoot
  ]) {
    const resolved = path.resolve(directory);
    const metadata = await lstat(resolved);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (process.platform !== "win32" &&
        (await realpath(resolved)) !== resolved)
    ) {
      throw new Error("Research runtime storage path is not canonical.");
    }
    if (process.platform !== "win32") {
      await chmod(resolved, 0o700);
    }
  }
  const databasePath = path.resolve(config.databasePath);
  try {
    const metadata = await lstat(databasePath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      (process.platform !== "win32" &&
        (await realpath(databasePath)) !== databasePath)
    ) {
      throw new Error("Research database path is not a canonical file.");
    }
  } catch (error) {
    if (filesystemErrorCode(error) !== "ENOENT") {
      throw error;
    }
  }
}

async function createLiveDependencies(
  config: ResearchWorkerConfig,
  fetchImpl?: typeof fetch
): Promise<ResearchWorkerDependencies> {
  const secrets = await loadRuntimeSecrets(config, fetchImpl);
  return {
    medicalSkillBundle: getDefaultMedicalSkillBundle(),
    adapters: new LiveResearchAdapters({
      ...config.adapterOptions,
      ncbi: {
        ...config.adapterOptions.ncbi,
        apiKey: secrets.ncbiApiKey
      },
      orcid: {
        enabled: config.orcid.mode !== "disabled",
        ...(secrets.orcidBearerToken
          ? { bearerToken: secrets.orcidBearerToken }
          : {})
      },
      officialWeb: {
        ...config.adapterOptions.officialWeb,
        ...(secrets.webSearchApiKey
          ? { apiKey: secrets.webSearchApiKey }
          : {})
      },
      fetchImpl
    }),
    modelClient: new GatewayResearchModelClient({
      ...config.llm,
      bearerToken: secrets.llmBearerToken,
      readinessRequirements: {
        maximumPromptTokensPerCall:
          config.workflowPolicy.maximumInputTokensPerCall,
        maximumOutputTokensPerCall:
          config.workflowPolicy.maximumOutputTokensPerCall,
        callsPerRun: config.workflowPolicy.budgets.llmCalls,
        concurrentCalls:
          config.workflowPolicy.synthesisShardCount ?? 1,
        maximumTokensPerRun:
          config.workflowPolicy.budgets.inputTokens +
          config.workflowPolicy.budgets.outputTokens
      },
      fetchImpl
    })
  };
}

async function assertStorageAvailable(
  config: ResearchWorkerConfig
): Promise<void> {
  const report = await probeResearchStorageAdmission({
    filesystemPath: config.artifactRoot,
    researchRoot: path.dirname(config.databasePath),
    policy: config.storagePolicy
  });
  if (!report.available) {
    throw new Error("Research storage admission limits are not satisfied.");
  }
}

function assertBackupFresh(
  store: ResearchSqliteStore,
  config: ResearchWorkerConfig
): void {
  const latest = store.latestSuccessfulBackupAt();
  const ageMs = latest ? Date.now() - latest.getTime() : Number.POSITIVE_INFINITY;
  if (
    !latest ||
    ageMs < 0 ||
    ageMs > config.backupMaxAgeMs
  ) {
    throw new Error(
      "Research Worker requires a fresh verified maintenance backup."
    );
  }
}

async function loadRuntimeSecrets(
  config: ResearchWorkerConfig,
  fetchImpl?: typeof fetch
): Promise<{
  llmBearerToken: string;
  webSearchApiKey: string | undefined;
  ncbiApiKey: string | undefined;
  orcidBearerToken: string | undefined;
}> {
  const llmBearerToken = await readSecretFile(
    config.llm.bearerTokenFile,
    "Research LLM bearer token"
  );
  const webSearchApiKey = config.webSearchApiKeyFile
    ? await readSecretFile(
        config.webSearchApiKeyFile,
        "Research web search API key"
      )
    : undefined;
  const ncbiApiKey = config.ncbiApiKeyFile
    ? await readSecretFile(config.ncbiApiKeyFile, "NCBI API key")
    : undefined;
  const orcidBearerToken =
    config.orcid.mode === "disabled" ||
    config.orcid.mode === "anonymous"
      ? undefined
      : config.orcid.mode === "bearer_file"
        ? await readSecretFile(
            config.orcid.bearerTokenFile,
            "ORCID bearer token"
          )
        : await obtainOrcidToken({
            clientId: await readSecretFile(
              config.orcid.clientIdFile,
              "ORCID client ID"
            ),
            clientSecret: await readSecretFile(
              config.orcid.clientSecretFile,
              "ORCID client secret"
            ),
            fetchImpl
          });
  return {
    llmBearerToken,
    webSearchApiKey,
    ncbiApiKey,
    orcidBearerToken
  };
}

async function obtainOrcidToken(input: {
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const body = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    grant_type: "client_credentials",
    scope: "/read-public"
  }).toString();
  const response = await fetchBoundedJson<{
    access_token?: unknown;
    scope?: unknown;
  }>({
    url: new URL("https://orcid.org/oauth/token"),
    signal: AbortSignal.timeout(30_000),
    timeoutMs: 30_000,
    maximumBytes: 100_000,
    method: "POST",
    body,
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded"
    },
    fetchImpl: input.fetchImpl
  });
  if (
    typeof response.value.access_token !== "string" ||
    response.value.access_token.length < 8 ||
    response.value.scope !== "/read-public"
  ) {
    throw new Error("ORCID did not return a /read-public token.");
  }
  return response.value.access_token;
}

function heartbeat(
  store: ResearchSqliteStore,
  config: ResearchWorkerConfig,
  processInstanceId: string,
  startedAt: Date,
  state: "starting" | "ready" | "draining"
): "recorded" | "stale_process_ignored" {
  return store.recordWorkerHeartbeat({
    workerId: config.workerId,
    processInstanceId,
    version: config.processVersion,
    state,
    startedAt
  }).outcome;
}

async function runReconciliation(
  store: ResearchSqliteStore,
  config: ResearchWorkerConfig
): Promise<void> {
  store.reconcileTtl({ batchSize: config.reconcileBatchSize });
  store.maintainIdempotency({ batchSize: config.reconcileBatchSize });
}

async function withDatabaseMaintenanceLock(input: {
  store: ResearchSqliteStore;
  name: ResearchMaintenanceLockName;
  owner: string;
  required: boolean;
  signal: AbortSignal;
  operation: () => void | Promise<void>;
}): Promise<void> {
  const leaseSeconds = 90;
  const acquisitionDeadline = Date.now() + 120_000;
  let acquired = false;
  do {
    acquired = input.store.acquireMaintenanceLock({
      name: input.name,
      owner: input.owner,
      leaseSeconds
    });
    if (
      acquired ||
      !input.required ||
      Date.now() >= acquisitionDeadline ||
      input.signal.aborted
    ) {
      break;
    }
    await delay(1_000, input.signal);
  } while (!acquired);
  if (!acquired) {
    if (input.signal.aborted) {
      throw input.signal.reason;
    }
    if (input.required) {
      throw new Error(
        `Research ${input.name} maintenance lock is already held.`
      );
    }
    return;
  }
  let lockLost = false;
  const renewal = setInterval(() => {
    if (input.signal.aborted) {
      lockLost = true;
      return;
    }
    try {
      if (
        !input.store.renewMaintenanceLock({
          name: input.name,
          owner: input.owner,
          leaseSeconds
        })
      ) {
        lockLost = true;
      }
    } catch {
      lockLost = true;
    }
  }, 20_000);
  renewal.unref();
  try {
    await input.operation();
    if (lockLost) {
      throw new Error(
        `Research ${input.name} maintenance lock was lost.`
      );
    }
  } finally {
    clearInterval(renewal);
    input.store.releaseMaintenanceLock({
      name: input.name,
      owner: input.owner
    });
  }
}

async function withBackupMaintenanceLocks(input: {
  store: ResearchSqliteStore;
  owner: string;
  required: boolean;
  signal: AbortSignal;
  operation: () => void | Promise<void>;
}): Promise<void> {
  await withDatabaseMaintenanceLock({
    ...input,
    name: "backup",
    operation: () =>
      withDatabaseMaintenanceLock({
        ...input,
        name: "cleanup"
      })
  });
}

async function runCleanup(
  store: ResearchSqliteStore,
  config: ResearchWorkerConfig
): Promise<void> {
  const cleaned = store.cleanupExpiredData({
    batchSize: config.cleanupBatchSize
  });
  await deleteResearchArtifactFiles({
    root: config.artifactRoot,
    storageRelativePaths: cleaned.artifactStorageRelativePaths
  });
  await recoverOrphanResearchArtifacts({
    root: config.artifactRoot,
    committedRelativePaths: new Set(
      store.listCommittedArtifactStoragePaths()
    ),
    now: new Date(),
    graceMs: config.orphanGraceMs
  });
}

async function runBackup(
  store: ResearchSqliteStore,
  config: ResearchWorkerConfig,
  logger: ResearchWorkerLogger
): Promise<void> {
  const backupId = `drb_${randomUUID().replaceAll("-", "")}`;
  store.recordBackupStarted({
    backupId,
    schemaVersion: "research_backup_manifest.v1"
  });
  let recordedSuccess = false;
  try {
    const snapshot = await createResearchBackupSnapshot({
      sourceDatabase: store.database,
      artifactRoot: config.artifactRoot,
      backupRoot: config.backupRoot,
      backupId,
      now: new Date()
    });
    const verified = await verifyResearchBackupSnapshot({
      backupDirectory: snapshot.backupDirectory
    });
    if (!verified.passed) {
      throw new Error("Research backup verification failed.");
    }
    store.recordBackupCompleted({
      backupId,
      outcome: "succeeded",
      manifestSha256: snapshot.manifestSha256
    });
    recordedSuccess = true;
    await pruneBackupSnapshots(config);
    logger.info("research_backup_succeeded", {
      backup_id: backupId,
      artifact_count: snapshot.manifest.artifacts.length
    });
  } catch (error) {
    if (!recordedSuccess) {
      try {
        store.recordBackupCompleted({
          backupId,
          outcome: "failed",
          errorCode: "backup_failed"
        });
      } finally {
        try {
          await removeFailedBackupSnapshot(config.backupRoot, backupId);
        } catch (cleanupError) {
          logger.error("research_backup_cleanup_failed", {
            backup_id: backupId,
            error_type:
              cleanupError instanceof Error ? cleanupError.name : "unknown"
          });
        }
      }
    }
    throw error;
  }
}

async function removeFailedBackupSnapshot(
  backupRoot: string,
  backupId: string
): Promise<void> {
  if (!/^drb_[a-f0-9]{16,64}$/u.test(backupId)) {
    throw new Error("Research failed-backup ID is invalid.");
  }
  const canonicalRoot = await realpath(path.resolve(backupRoot));
  const candidate = path.resolve(canonicalRoot, backupId);
  if (path.dirname(candidate) !== canonicalRoot) {
    throw new Error("Research failed-backup path is invalid.");
  }
  let metadata;
  try {
    metadata = await lstat(candidate);
  } catch (error) {
    if (filesystemErrorCode(error) === "ENOENT") {
      return;
    }
    throw error;
  }
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (await realpath(candidate)) !== candidate
  ) {
    throw new Error("Research failed-backup entry is invalid.");
  }
  await rm(candidate, { recursive: true });
}

async function pruneBackupSnapshots(
  config: ResearchWorkerConfig
): Promise<void> {
  const canonicalRoot = await realpath(config.backupRoot);
  const entries = await readdir(canonicalRoot, { withFileTypes: true });
  const backups: Array<{ name: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      !/^drb_[a-f0-9]{16,64}$/u.test(entry.name)
    ) {
      continue;
    }
    const candidate = path.resolve(canonicalRoot, entry.name);
    const metadata = await lstat(candidate);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Research backup retention entry is invalid.");
    }
    backups.push({ name: entry.name, mtimeMs: metadata.mtimeMs });
  }
  backups.sort(
    (left, right) =>
      right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name)
  );
  for (const entry of backups.slice(config.backupRetentionCount)) {
    const candidate = path.resolve(canonicalRoot, entry.name);
    if (
      path.dirname(candidate) !== canonicalRoot ||
      !/^drb_[a-f0-9]{16,64}$/u.test(path.basename(candidate))
    ) {
      throw new Error("Research backup retention path is invalid.");
    }
    const metadata = await lstat(candidate);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Research backup retention entry is invalid.");
    }
    if (await realpath(candidate) !== candidate) {
      throw new Error("Research backup retention path is not canonical.");
    }
    await rm(candidate, { recursive: true });
  }
}

function convergeCancellation(
  store: ResearchSqliteStore,
  token: Parameters<ResearchSqliteStore["renewLease"]>[0]["token"],
  leaseSeconds: number
): void {
  const renewed = store.renewLease({ token, leaseSeconds });
  if (renewed.outcome === "renewed" && renewed.cancelRequested) {
    store.completeCancellation({ token: renewed.token });
  }
}

function recurring(
  intervalMs: number,
  operation: () => unknown | Promise<unknown>,
  logger: ResearchWorkerLogger,
  name: string,
  onError?: (error: unknown) => void
): NodeJS.Timeout {
  const timer = setInterval(() => {
    void Promise.resolve()
      .then(operation)
      .catch((error) => {
        logger.error(`research_${name}_failed`, {
          error_type: error instanceof Error ? error.name : "unknown"
        });
        onError?.(error);
      });
  }, intervalMs);
  // These recurring jobs are part of the Worker/maintenance lifecycle. At
  // least one referenced handle must keep a standalone maintenance process
  // alive while it is awaiting SIGINT/SIGTERM; an unresolved Promise alone
  // does not keep the Node.js event loop running.
  return timer;
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const aborted = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    }, milliseconds);
    if (signal.aborted) {
      aborted();
      return;
    }
    signal.addEventListener("abort", aborted, { once: true });
  });
}

function filesystemErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String(error.code)
    : undefined;
}
