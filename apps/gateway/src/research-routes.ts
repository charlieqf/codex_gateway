import { createHash } from "node:crypto";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest
} from "fastify";
import {
  GatewayError,
  hasFeatureCapability,
  isRecord,
  researchRunStages,
  researchRunStatuses,
  type DoctorResearchRunInput,
  type PlanEntitlementStore,
  type RateLimitPolicy,
  type ResearchIdentityCandidate,
  type ResearchRunRecord,
  type ResearchRunStatus,
  type ResearchWorkerStore,
  type ResolveResearchIdentityInput,
  type ResearchStore
} from "@codex-gateway/core";
import { openVerifiedResearchArtifactStream } from "@codex-gateway/research-agent";
import { getGatewayContext, researchRouteConfig } from "./http/context.js";
import type { CredentialRateLimiter } from "./services/rate-limiter.js";
import {
  applyGatewayErrorHeaders,
  researchErrorPayload,
  type ResearchErrorCode
} from "./http/error-response.js";
import {
  markGatewayError,
  markLimitKind,
  markRateLimitOrigin
} from "./http/observation.js";

const statusBase = "/gateway/research/v1/doctor-runs";
const cursorLifetimeMs = 60 * 60 * 1000;

export interface ResearchRouteOptions {
  store: ResearchStore;
  planEntitlementStore?: PlanEntitlementStore;
  rateLimiter: CredentialRateLimiter;
  readRatePolicy: RateLimitPolicy;
  mutationRatePolicy: RateLimitPolicy;
  workerHealthStore?: Pick<ResearchWorkerStore, "listWorkerHeartbeats">;
  acceptWhenWorkerUnavailable?: boolean;
  workerStaleAfterSeconds?: number;
  artifactRoot?: string;
  maximumArtifactBytes?: number;
  admissionGuard?: (now: Date) => Promise<GatewayError | null>;
  now?: () => Date;
}

interface ParsedResearchRunRequest {
  input: DoctorResearchRunInput;
  requestHash: string;
  identityFingerprint: string;
}

export function registerResearchRoutes(
  app: FastifyInstance,
  options: ResearchRouteOptions
): void {
  const now = options.now ?? (() => new Date());

  app.post<{ Body: unknown }>(
    statusBase,
    { config: researchRouteConfig },
    async (request, reply) => {
      const controlError = researchControlRateLimitError(
        request,
        options,
        "mutation"
      );
      if (controlError) {
        return sendResearchError(
          request,
          reply,
          controlError,
          "research_quota_exceeded"
        );
      }
      const capabilityError = researchCapabilityError(request, options);
      if (capabilityError) {
        return sendResearchError(request, reply, capabilityError);
      }
      let parsed: ParsedResearchRunRequest;
      let idempotencyKey: string;
      try {
        parsed = parseDoctorResearchRunRequest(request.body);
        idempotencyKey = parseIdempotencyKey(
          request.headers["idempotency-key"]
        );
      } catch (error) {
        return sendResearchError(
          request,
          reply,
          error instanceof GatewayError ? error : invalidRequest()
        );
      }
      const context = getGatewayContext(request);
      try {
        const idempotency = options.store.inspectCreateRunIdempotency({
          subjectId: context.subject.id,
          credentialId: context.credential.id,
          requestId: request.id,
          idempotencyKey,
          requestHash: parsed.requestHash,
          now: now()
        });
        if (idempotency.outcome === "replayed") {
          reply.code(202);
          return idempotency.receipt;
        }
        if (idempotency.outcome === "idempotency_conflict") {
          return sendResearchError(
            request,
            reply,
            new GatewayError({
              code: "idempotency_conflict",
              message:
                "Idempotency key was already used for a different request.",
              httpStatus: 409
            })
          );
        }
        if (idempotency.outcome === "idempotency_expired") {
          return sendResearchError(
            request,
            reply,
            new GatewayError({
              code: "idempotency_expired",
              message: "Idempotency replay window has expired.",
              httpStatus: 409
            })
          );
        }
      } catch (error) {
        request.log.error(
          {
            request_id: request.id,
            error_type: error instanceof Error ? error.name : "unknown"
          },
          "Research idempotency lookup failed."
        );
        return sendResearchError(request, reply, researchStorageUnavailable());
      }
      const workerError = researchWorkerAvailabilityError(options, now());
      if (workerError) {
        return sendResearchError(request, reply, workerError);
      }
      if (options.admissionGuard) {
        let admissionError: GatewayError | null;
        try {
          admissionError = await options.admissionGuard(now());
        } catch (error) {
          request.log.error(
            {
              request_id: request.id,
              error_type: error instanceof Error ? error.name : "unknown"
            },
            "Research admission probe failed."
          );
          admissionError = researchStorageUnavailable();
        }
        if (admissionError) {
          return sendResearchError(request, reply, admissionError);
        }
      }

      try {
        const result = options.store.createRun({
          subjectId: context.subject.id,
          credentialId: context.credential.id,
          requestId: request.id,
          idempotencyKey,
          requestHash: parsed.requestHash,
          identityFingerprint: parsed.identityFingerprint,
          input: parsed.input,
          now: now()
        });
        if (result.outcome === "idempotency_conflict") {
          return sendResearchError(
            request,
            reply,
            new GatewayError({
              code: "idempotency_conflict",
              message: "Idempotency key was already used for a different request.",
              httpStatus: 409
            })
          );
        }
        if (result.outcome === "idempotency_expired") {
          return sendResearchError(
            request,
            reply,
            new GatewayError({
              code: "idempotency_expired",
              message: "Idempotency replay window has expired.",
              httpStatus: 409
            })
          );
        }
        if (result.outcome === "rate_limited") {
          markLimitKind(request, result.limitKind);
          markRateLimitOrigin(request, "gateway");
          return sendResearchError(
            request,
            reply,
            new GatewayError({
              code: "rate_limited",
              message: "Research quota exceeded.",
              httpStatus: 429,
              retryAfterSeconds: 30
            }),
            "research_quota_exceeded"
          );
        }

        reply.code(202);
        return result.receipt;
      } catch (error) {
        request.log.error(
          {
            request_id: request.id,
            error_type: error instanceof Error ? error.name : "unknown"
          },
          "Research run creation failed."
        );
        return sendResearchError(request, reply, researchStorageUnavailable());
      }
    }
  );

  app.get<{
    Querystring: {
      limit?: string;
      status?: string;
      cursor?: string;
    };
  }>(
    statusBase,
    { config: researchRouteConfig },
    async (request, reply) => {
      const controlError = researchControlRateLimitError(
        request,
        options,
        "read"
      );
      if (controlError) {
        return sendResearchError(
          request,
          reply,
          controlError,
          "research_quota_exceeded"
        );
      }
      const capabilityError = researchCapabilityError(request, options);
      if (capabilityError) {
        return sendResearchError(request, reply, capabilityError);
      }
      try {
        const currentTime = now();
        const limit = parseListLimit(request.query.limit);
        const status = parseListStatus(request.query.status);
        const before = request.query.cursor
          ? decodeCursor(request.query.cursor, status, currentTime)
          : undefined;
        const { subject } = getGatewayContext(request);
        const runs = options.store.listRunsForSubject({
          subjectId: subject.id,
          ...(status ? { status } : {}),
          limit: limit + 1,
          now: currentTime,
          ...(before ? { before } : {})
        });
        const hasMore = runs.length > limit;
        const items = runs.slice(0, limit);
        const last = hasMore ? items.at(-1) : undefined;
        return {
          schema_version: "doctor_research_run_list.v1",
          request_id: request.id,
          items: items.map((run) => publicRunSummary(run, currentTime)),
          next_cursor: last
            ? encodeCursor(last, status, currentTime)
            : null
        };
      } catch (error) {
        if (error instanceof GatewayError) {
          return sendResearchError(request, reply, error);
        }
        request.log.error(
          {
            request_id: request.id,
            error_type: error instanceof Error ? error.name : "unknown"
          },
          "Research run listing failed."
        );
        return sendResearchError(request, reply, researchStorageUnavailable());
      }
    }
  );

  app.post<{ Params: { runId: string }; Body: unknown }>(
    `${statusBase}/:runId/cancel`,
    { config: researchRouteConfig },
    async (request, reply) => {
      const controlError = researchControlRateLimitError(
        request,
        options,
        "mutation"
      );
      if (controlError) {
        return sendResearchError(
          request,
          reply,
          controlError,
          "research_quota_exceeded"
        );
      }
      const capabilityError = researchCapabilityError(request, options);
      if (capabilityError) {
        return sendResearchError(request, reply, capabilityError);
      }
      if (!/^drr_[a-f0-9]{32}$/.test(request.params.runId)) {
        return sendResearchError(request, reply, runNotFound());
      }
      let idempotencyKey: string;
      try {
        idempotencyKey = parseIdempotencyKey(
          request.headers["idempotency-key"]
        );
        if (
          request.body !== undefined &&
          (!isRecord(request.body) || Object.keys(request.body).length !== 0)
        ) {
          throw invalidRequest();
        }
      } catch (error) {
        return sendResearchError(
          request,
          reply,
          error instanceof GatewayError ? error : invalidRequest()
        );
      }

      try {
        const context = getGatewayContext(request);
        const result = options.store.requestCancel({
          runId: request.params.runId,
          subjectId: context.subject.id,
          credentialId: context.credential.id,
          requestId: request.id,
          idempotencyKey,
          requestHash: sha256(
            `doctor_research_cancel.v1\u0000${request.params.runId}`
          ),
          now: now()
        });
        if (result.outcome === "not_found") {
          return sendResearchError(request, reply, runNotFound());
        }
        if (result.outcome === "idempotency_conflict") {
          return sendResearchError(
            request,
            reply,
            new GatewayError({
              code: "idempotency_conflict",
              message:
                "Idempotency key was already used for a different request.",
              httpStatus: 409
            })
          );
        }
        if (result.outcome === "idempotency_expired") {
          return sendResearchError(
            request,
            reply,
            new GatewayError({
              code: "idempotency_expired",
              message: "Idempotency replay window has expired.",
              httpStatus: 409
            })
          );
        }
        if (result.outcome === "invalid_transition") {
          return sendResearchError(
            request,
            reply,
            new GatewayError({
              code: "invalid_run_transition",
              message: `A ${result.status} Research run cannot be cancelled.`,
              httpStatus: 409
            })
          );
        }
        return result.receipt;
      } catch (error) {
        request.log.error(
          {
            request_id: request.id,
            error_type: error instanceof Error ? error.name : "unknown"
          },
          "Research run cancellation failed."
        );
        return sendResearchError(request, reply, researchStorageUnavailable());
      }
    }
  );

  app.get<{ Params: { runId: string } }>(
    `${statusBase}/:runId`,
    { config: researchRouteConfig },
    async (request, reply) => {
      const controlError = researchControlRateLimitError(
        request,
        options,
        "read"
      );
      if (controlError) {
        return sendResearchError(
          request,
          reply,
          controlError,
          "research_quota_exceeded"
        );
      }
      const capabilityError = researchCapabilityError(request, options);
      if (capabilityError) {
        return sendResearchError(request, reply, capabilityError);
      }
      if (!/^drr_[a-f0-9]{32}$/.test(request.params.runId)) {
        return sendResearchError(request, reply, runNotFound());
      }
      try {
        const { subject } = getGatewayContext(request);
        const run = options.store.getRunForSubject(
          request.params.runId,
          subject.id
        );
        if (!run) {
          return sendResearchError(request, reply, runNotFound());
        }
        const currentTime = now();
        if (logicalStatus(run, currentTime) === "expired") {
          return sendResearchError(request, reply, runExpired());
        }
        const candidates =
          logicalStatus(run, currentTime) === "needs_input"
            ? options.store.listIdentityCandidatesForSubject(
                run.runId,
                subject.id
              )
            : [];
        return publicRunStatus(run, request.id, currentTime, candidates);
      } catch (error) {
        request.log.error(
          {
            request_id: request.id,
            error_type: error instanceof Error ? error.name : "unknown"
          },
          "Research run lookup failed."
        );
        return sendResearchError(request, reply, researchStorageUnavailable());
      }
    }
  );

  app.get<{ Params: { runId: string } }>(
    `${statusBase}/:runId/result`,
    { config: researchRouteConfig },
    async (request, reply) => {
      const controlError = researchControlRateLimitError(
        request,
        options,
        "read"
      );
      if (controlError) {
        return sendResearchError(
          request,
          reply,
          controlError,
          "research_quota_exceeded"
        );
      }
      const capabilityError = researchCapabilityError(request, options);
      if (capabilityError) {
        return sendResearchError(request, reply, capabilityError);
      }
      if (!/^drr_[a-f0-9]{32}$/.test(request.params.runId)) {
        return sendResearchError(request, reply, runNotFound());
      }
      try {
        const { subject } = getGatewayContext(request);
        const run = options.store.getRunForSubject(
          request.params.runId,
          subject.id
        );
        if (!run) {
          return sendResearchError(request, reply, runNotFound());
        }
        const currentTime = now();
        const status = logicalStatus(run, currentTime);
        if (status === "expired") {
          return sendResearchError(request, reply, runExpired());
        }
        if (status !== "succeeded") {
          return sendResearchError(request, reply, runNotComplete());
        }
        const stored = options.store.getRunResultForSubject(
          run.runId,
          subject.id
        );
        if (!stored) {
          throw new Error("Succeeded Research run has no stored result.");
        }
        return {
          ...stored.result,
          schema_version: stored.schemaVersion,
          request_id: request.id,
          run_id: run.runId
        };
      } catch (error) {
        request.log.error(
          {
            request_id: request.id,
            error_type: error instanceof Error ? error.name : "unknown"
          },
          "Research result lookup failed."
        );
        return sendResearchError(
          request,
          reply,
          researchStorageUnavailable()
        );
      }
    }
  );

  app.post<{ Params: { runId: string }; Body: unknown }>(
    `${statusBase}/:runId/identity-selection`,
    { config: researchRouteConfig },
    async (request, reply) => {
      const controlError = researchControlRateLimitError(
        request,
        options,
        "mutation"
      );
      if (controlError) {
        return sendResearchError(
          request,
          reply,
          controlError,
          "research_quota_exceeded"
        );
      }
      const capabilityError = researchCapabilityError(request, options);
      if (capabilityError) {
        return sendResearchError(request, reply, capabilityError);
      }
      if (!/^drr_[a-f0-9]{32}$/.test(request.params.runId)) {
        return sendResearchError(request, reply, runNotFound());
      }
      let idempotencyKey: string;
      let selection: ResolveResearchIdentityInput["selection"];
      try {
        idempotencyKey = parseIdempotencyKey(
          request.headers["idempotency-key"]
        );
        selection = parseIdentitySelection(request.body);
      } catch (error) {
        return sendResearchError(
          request,
          reply,
          error instanceof GatewayError ? error : invalidRequest()
        );
      }
      if (selection.action === "select") {
        const workerError = researchWorkerAvailabilityError(options, now());
        if (workerError) {
          return sendResearchError(request, reply, workerError);
        }
      }
      try {
        const context = getGatewayContext(request);
        const result = options.store.resolveIdentity({
          runId: request.params.runId,
          subjectId: context.subject.id,
          credentialId: context.credential.id,
          requestId: request.id,
          idempotencyKey,
          requestHash: sha256(
            `doctor_research_identity_selection.v1\u0000${request.params.runId}\u0000${JSON.stringify(selection)}`
          ),
          selection,
          now: now()
        });
        if (result.outcome === "not_found") {
          return sendResearchError(request, reply, runNotFound());
        }
        if (result.outcome === "idempotency_conflict") {
          return sendResearchError(
            request,
            reply,
            new GatewayError({
              code: "idempotency_conflict",
              message:
                "Idempotency key was already used for a different request.",
              httpStatus: 409
            })
          );
        }
        if (result.outcome === "idempotency_expired") {
          return sendResearchError(
            request,
            reply,
            new GatewayError({
              code: "idempotency_expired",
              message: "Idempotency replay window has expired.",
              httpStatus: 409
            })
          );
        }
        if (result.outcome === "identity_selection_not_expected") {
          return sendResearchError(
            request,
            reply,
            new GatewayError({
              code: "identity_selection_not_expected",
              message: "This Research run is not awaiting identity selection.",
              httpStatus: 409
            })
          );
        }
        if (result.outcome === "candidate_not_found") {
          return sendResearchError(request, reply, invalidRequest());
        }
        if (result.outcome === "rate_limited") {
          markLimitKind(request, result.limitKind);
          markRateLimitOrigin(request, "gateway");
          return sendResearchError(
            request,
            reply,
            new GatewayError({
              code: "rate_limited",
              message: "An active Research brief already exists.",
              httpStatus: 429,
              retryAfterSeconds: 30
            }),
            "research_quota_exceeded"
          );
        }
        return result.receipt;
      } catch (error) {
        request.log.error(
          {
            request_id: request.id,
            error_type: error instanceof Error ? error.name : "unknown"
          },
          "Research identity selection failed."
        );
        return sendResearchError(request, reply, researchStorageUnavailable());
      }
    }
  );

  app.get<{ Params: { artifactId: string } }>(
    "/gateway/research/v1/artifacts/:artifactId/download",
    { config: researchRouteConfig },
    async (request, reply) => {
      const controlError = researchControlRateLimitError(
        request,
        options,
        "read"
      );
      if (controlError) {
        return sendResearchError(
          request,
          reply,
          controlError,
          "research_quota_exceeded"
        );
      }
      const capabilityError = researchCapabilityError(request, options);
      if (capabilityError) {
        return sendResearchError(request, reply, capabilityError);
      }
      if (!/^dra_[a-f0-9]{32}$/.test(request.params.artifactId)) {
        return sendResearchError(request, reply, artifactNotFound());
      }
      try {
        const currentTime = now();
        const { subject } = getGatewayContext(request);
        const artifact = options.store.getArtifactForSubject(
          request.params.artifactId,
          subject.id
        );
        if (!artifact) {
          return sendResearchError(request, reply, artifactNotFound());
        }
        if (artifact.expiresAt.getTime() <= currentTime.getTime()) {
          return sendResearchError(request, reply, artifactExpired());
        }
        if (!options.artifactRoot || !options.maximumArtifactBytes) {
          throw new Error("Research artifact delivery is not configured.");
        }
        const verified = await openVerifiedResearchArtifactStream({
          root: options.artifactRoot,
          artifact,
          maximumArtifactBytes: options.maximumArtifactBytes
        });
        reply.header("content-type", artifact.contentType);
        reply.header(
          "content-disposition",
          contentDisposition(artifact.filenameAscii, artifact.filenameUtf8)
        );
        reply.header("cache-control", "private, no-store");
        reply.header("referrer-policy", "no-referrer");
        reply.header("x-content-type-options", "nosniff");
        reply.header("content-length", String(verified.sizeBytes));
        return reply.send(verified.stream);
      } catch (error) {
        request.log.error(
          {
            request_id: request.id,
            artifact_id: request.params.artifactId,
            error_type: error instanceof Error ? error.name : "unknown"
          },
          "Research artifact download failed."
        );
        return sendResearchError(
          request,
          reply,
          researchStorageUnavailable()
        );
      }
    }
  );
}

export function parseDoctorResearchRunRequest(
  body: unknown
): ParsedResearchRunRequest {
  if (!isRecord(body)) {
    throw invalidRequest();
  }
  assertOnlyKeys(body, [
    "doctor",
    "mode",
    "language",
    "options",
    "client_reference"
  ]);
  if (!isRecord(body.doctor) || !isRecord(body.options)) {
    throw invalidRequest();
  }
  assertOnlyKeys(body.doctor, [
    "name",
    "hospital",
    "department",
    "title",
    "city",
    "orcid"
  ]);
  assertOnlyKeys(body.options, ["publication_years", "citation_style"]);

  const doctor = {
    name: normalizedText(body.doctor.name, "doctor.name", 2, 100),
    hospital: optionalText(body.doctor.hospital, "doctor.hospital", 200),
    department: optionalText(
      body.doctor.department,
      "doctor.department",
      200
    ),
    title: optionalText(body.doctor.title, "doctor.title", 100),
    city: optionalText(body.doctor.city, "doctor.city", 100),
    orcid: optionalOrcid(body.doctor.orcid)
  };
  if (!doctor.hospital || !doctor.department) {
    throw new GatewayError({
      code: "invalid_request",
      message:
        "The controlled Doctor Research beta requires both hospital and department identity anchors.",
      httpStatus: 400
    });
  }
  const officialSearchQuery = [
    `"${doctor.name}"`,
    doctor.hospital,
    doctor.department,
    "doctor profile"
  ].join(" ");
  if (
    officialSearchQuery.length > 280 ||
    officialSearchQuery.split(/\s+/u).length > 40
  ) {
    throw new GatewayError({
      code: "invalid_request",
      message:
        "The doctor identity anchors are too long for controlled official-site search.",
      httpStatus: 400
    });
  }
  if (body.mode !== "brief") {
    throw new GatewayError({
      code: "invalid_request",
      message: "Only brief Doctor Research runs are currently supported.",
      httpStatus: 400
    });
  }
  if (body.language !== "zh-CN" && body.language !== "en") {
    throw invalidRequest();
  }
  const publicationYears = body.options.publication_years;
  if (
    typeof publicationYears !== "number" ||
    !Number.isSafeInteger(publicationYears) ||
    publicationYears < 1 ||
    publicationYears > 10
  ) {
    throw invalidRequest();
  }
  if (body.options.citation_style !== "vancouver") {
    throw invalidRequest();
  }
  const clientReference = optionalText(
    body.client_reference,
    "client_reference",
    128
  );
  const input: DoctorResearchRunInput = {
    doctor,
    mode: "brief",
    language: body.language,
    options: {
      publicationYears,
      citationStyle: "vancouver"
    },
    clientReference
  };
  const canonical = JSON.stringify(input);
  const identityCanonical = JSON.stringify({
    name: canonicalIdentityAnchor(doctor.name),
    hospital: canonicalIdentityAnchor(doctor.hospital),
    department: canonicalIdentityAnchor(doctor.department)
  });
  return {
    input,
    requestHash: sha256(canonical),
    identityFingerprint: sha256(
      `doctor_identity_input.v1\u0000${identityCanonical}`
    )
  };
}

function researchControlRateLimitError(
  request: FastifyRequest,
  options: ResearchRouteOptions,
  kind: "read" | "mutation"
): GatewayError | null {
  const context = getGatewayContext(request);
  const policy =
    kind === "read" ? options.readRatePolicy : options.mutationRatePolicy;
  const keys = [
    `credential:${
      context.credential.id ?? `dev:${context.subject.id}`
    }:research:${kind}`,
    `subject:${context.subject.id}:research:${kind}`
  ];
  const permits: Array<{ release(): void }> = [];
  for (const key of keys) {
    const result = options.rateLimiter.acquire({
      credentialId: key,
      policy
    });
    if ("release" in result) {
      permits.push(result);
      continue;
    }
    for (const permit of permits) {
      permit.release();
    }
    markLimitKind(
      request,
      kind === "read"
        ? "research_control_read_minute"
        : "research_control_mutation_minute",
      result.details
    );
    markRateLimitOrigin(request, "gateway");
    return new GatewayError({
      code: "rate_limited",
      message: `Research control-plane ${kind} rate limit exceeded.`,
      httpStatus: 429,
      retryAfterSeconds: result.error.retryAfterSeconds ?? 60
    });
  }
  for (const permit of permits) {
    permit.release();
  }
  return null;
}

function researchWorkerAvailabilityError(
  options: ResearchRouteOptions,
  now: Date
): GatewayError | null {
  if (options.acceptWhenWorkerUnavailable === true) {
    return null;
  }
  const staleAfterSeconds = options.workerStaleAfterSeconds ?? 45;
  const available =
    options.workerHealthStore?.listWorkerHeartbeats({
      now,
      staleAfterSeconds
    }).some((heartbeat) => heartbeat.available && heartbeat.state === "ready") ??
    false;
  if (available) {
    return null;
  }
  return new GatewayError({
    code: "research_worker_unavailable",
    message: "No healthy Research worker is currently available.",
    httpStatus: 503,
    retryAfterSeconds: 15
  });
}

function researchCapabilityError(
  request: FastifyRequest,
  options: ResearchRouteOptions
): GatewayError | null {
  const { subject } = getGatewayContext(request);
  try {
    const access = options.planEntitlementStore?.entitlementAccessForSubject(
      subject.id,
      options.now?.()
    );
    if (
      access?.status === "active" &&
      hasFeatureCapability(
        access.entitlement.featurePolicySnapshot,
        "doctor_research"
      )
    ) {
      return null;
    }
  } catch {
    return researchStorageUnavailable();
  }
  return new GatewayError({
    code: "research_capability_required",
    message: "Doctor Research capability is required.",
    httpStatus: 403
  });
}

function sendResearchError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: GatewayError,
  researchCode?: ResearchErrorCode
) {
  markGatewayError(request, error);
  const context = {
    requestId: request.id,
    limitKind: request.gatewayLimitKind,
    limitDetails: request.gatewayLimitDetails,
    rateLimitOrigin: request.gatewayRateLimitOrigin,
    researchCode
  };
  applyGatewayErrorHeaders(reply, error, context);
  reply.code(error.httpStatus);
  return researchErrorPayload(error, context);
}

function publicRunStatus(
  run: ResearchRunRecord,
  requestId: string,
  now: Date,
  candidates: readonly ResearchIdentityCandidate[] = []
) {
  const status = logicalStatus(run, now);
  const identitySelectionTimedOut =
    run.status === "needs_input" &&
    run.needsInputExpiresAt !== null &&
    run.needsInputExpiresAt.getTime() <= now.getTime();
  const terminalReason = identitySelectionTimedOut
    ? "identity_selection_timeout"
    : run.terminalReason;
  const terminalDetailPublic = identitySelectionTimedOut
    ? "Identity selection timed out."
    : run.terminalDetailPublic;
  const completedStages =
    status === "succeeded" ? researchRunStages.length : stageIndex(run.stage);
  const base = {
    schema_version: "doctor_research_run.v1",
    request_id: requestId,
    run_id: run.runId,
    status,
    stage: run.stage,
    progress: {
      completed_stages: completedStages,
      total_stages: researchRunStages.length,
      percent: status === "succeeded" ? 100 : run.progressPercent
    },
    warnings: run.warningCodes,
    created_at: run.createdAt.toISOString(),
    updated_at: run.updatedAt.toISOString(),
    ...(run.completedAt
      ? { completed_at: run.completedAt.toISOString() }
      : {}),
    ...(terminalReason
      ? {
          terminal_reason: terminalReason,
          terminal_detail_public: terminalDetailPublic
        }
      : {})
  };
  if (status !== "needs_input") {
    return base;
  }
  return {
    ...base,
    needs_input_expires_at: run.needsInputExpiresAt?.toISOString() ?? null,
    input_required: {
      type: "identity_selection",
      candidates: candidates.map((candidate) => ({
        candidate_id: candidate.candidateId,
        name: candidate.name,
        hospital: candidate.hospital,
        department: candidate.department,
        city: candidate.city,
        sources: candidate.sources
      }))
    }
  };
}

function publicRunSummary(run: ResearchRunRecord, now: Date) {
  return {
    run_id: run.runId,
    status: logicalStatus(run, now),
    stage: run.stage,
    mode: run.mode,
    doctor: {
      name: run.input.doctor.name,
      hospital: run.input.doctor.hospital,
      department: run.input.doctor.department
    },
    client_reference: run.input.clientReference,
    created_at: run.createdAt.toISOString(),
    updated_at: run.updatedAt.toISOString(),
    completed_at: run.completedAt?.toISOString() ?? null,
    expires_at: run.expiresAt?.toISOString() ?? null,
    status_url: `${statusBase}/${run.runId}`,
    result_url: `${statusBase}/${run.runId}/result`
  };
}

function logicalStatus(
  run: ResearchRunRecord,
  now: Date
): ResearchRunStatus {
  if (
    run.status === "needs_input" &&
    run.needsInputExpiresAt &&
    run.needsInputExpiresAt.getTime() <= now.getTime()
  ) {
    return "cancelled";
  }
  if (
    (run.status === "succeeded" ||
      run.status === "failed" ||
      run.status === "cancelled") &&
    run.expiresAt &&
    run.expiresAt.getTime() <= now.getTime()
  ) {
    return "expired";
  }
  return run.status;
}

function parseIdempotencyKey(value: string | string[] | undefined): string {
  if (
    typeof value !== "string" ||
    value.length > 128 ||
    !/^research:[A-Za-z0-9._:-]+$/.test(value)
  ) {
    throw new GatewayError({
      code: "invalid_request",
      message: "A valid Idempotency-Key is required.",
      httpStatus: 400
    });
  }
  return value;
}

function parseIdentitySelection(
  body: unknown
): ResolveResearchIdentityInput["selection"] {
  if (!isRecord(body)) {
    throw invalidRequest();
  }
  if (
    Object.keys(body).length === 1 &&
    typeof body.candidate_id === "string" &&
    /^dc_[a-f0-9]{16,64}$/.test(body.candidate_id)
  ) {
    return { action: "select", candidateId: body.candidate_id };
  }
  if (
    Object.keys(body).length === 1 &&
    body.action === "reject_all"
  ) {
    return { action: "reject_all" };
  }
  throw invalidRequest();
}

function parseListLimit(value: string | undefined): number {
  if (value === undefined) {
    return 20;
  }
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw invalidRequest();
  }
  const parsed = Number.parseInt(value, 10);
  if (parsed > 100) {
    throw invalidRequest();
  }
  return parsed;
}

function parseListStatus(value: string | undefined): ResearchRunStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!researchRunStatuses.includes(value as ResearchRunStatus)) {
    throw invalidRequest();
  }
  return value as ResearchRunStatus;
}

function encodeCursor(
  run: ResearchRunRecord,
  status: ResearchRunStatus | undefined,
  now: Date
): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      status: status ?? null,
      created_at: run.createdAt.toISOString(),
      run_id: run.runId,
      expires_at: new Date(now.getTime() + cursorLifetimeMs).toISOString()
    }),
    "utf8"
  ).toString("base64url");
}

function decodeCursor(
  value: string,
  status: ResearchRunStatus | undefined,
  now: Date
): { createdAt: Date; runId: string } {
  try {
    if (value.length === 0 || value.length > 1_024) {
      throw invalidRequest();
    }
    const decoded = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8")
    ) as unknown;
    if (
      !isRecord(decoded) ||
      Object.keys(decoded).length !== 5 ||
      decoded.v !== 1 ||
      decoded.status !== (status ?? null) ||
      typeof decoded.created_at !== "string" ||
      typeof decoded.run_id !== "string" ||
      typeof decoded.expires_at !== "string" ||
      !/^drr_[a-f0-9]{32}$/.test(decoded.run_id)
    ) {
      throw invalidRequest();
    }
    const createdAt = new Date(decoded.created_at);
    const expiresAt = new Date(decoded.expires_at);
    if (
      Number.isNaN(createdAt.getTime()) ||
      Number.isNaN(expiresAt.getTime()) ||
      expiresAt.getTime() <= now.getTime() ||
      expiresAt.getTime() > now.getTime() + cursorLifetimeMs ||
      createdAt.getTime() > now.getTime()
    ) {
      throw invalidRequest();
    }
    return { createdAt, runId: decoded.run_id };
  } catch (error) {
    if (error instanceof GatewayError) {
      throw error;
    }
    throw invalidRequest();
  }
}

function normalizedText(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number
): string {
  if (typeof value !== "string") {
    throw invalidRequest();
  }
  const normalized = value.normalize("NFC").trim();
  const length = Array.from(normalized).length;
  if (
    length < minimum ||
    length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(normalized) ||
    hasUnpairedSurrogate(normalized)
  ) {
    throw new GatewayError({
      code: "invalid_request",
      message: `${field} is invalid.`,
      httpStatus: 400
    });
  }
  return normalized;
}

function canonicalIdentityAnchor(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/gu, " ")
    .trim();
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (
        index + 1 >= value.length ||
        next < 0xdc00 ||
        next > 0xdfff
      ) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function optionalText(
  value: unknown,
  field: string,
  maximum: number
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return normalizedText(value, field, 1, maximum);
}

function optionalOrcid(value: unknown): string | null {
  const normalized = optionalText(value, "doctor.orcid", 19);
  if (
    normalized !== null &&
    (!/^[0-9]{4}-[0-9]{4}-[0-9]{4}-[0-9]{3}[0-9X]$/.test(normalized) ||
      !hasValidOrcidChecksum(normalized))
  ) {
    throw new GatewayError({
      code: "invalid_request",
      message: "doctor.orcid is invalid.",
      httpStatus: 400
    });
  }
  return normalized;
}

function hasValidOrcidChecksum(value: string): boolean {
  const compact = value.replaceAll("-", "");
  let total = 0;
  for (const digit of compact.slice(0, 15)) {
    total = (total + Number(digit)) * 2;
  }
  const checkValue = (12 - (total % 11)) % 11;
  return compact[15] === (checkValue === 10 ? "X" : String(checkValue));
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[]
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw invalidRequest();
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stageIndex(stage: string): number {
  const index = researchRunStages.indexOf(
    stage as (typeof researchRunStages)[number]
  );
  return Math.max(0, index);
}

function invalidRequest(): GatewayError {
  return new GatewayError({
    code: "invalid_request",
    message: "Invalid Doctor Research request.",
    httpStatus: 400
  });
}

function runNotFound(): GatewayError {
  return new GatewayError({
    code: "run_not_found",
    message: "Research run was not found.",
    httpStatus: 404
  });
}

function runExpired(): GatewayError {
  return new GatewayError({
    code: "run_expired",
    message: "Research run has expired.",
    httpStatus: 410
  });
}

function runNotComplete(): GatewayError {
  return new GatewayError({
    code: "run_not_complete",
    message: "Research run has not completed successfully.",
    httpStatus: 409
  });
}

function researchStorageUnavailable(): GatewayError {
  return new GatewayError({
    code: "research_storage_unavailable",
    message: "Research storage is temporarily unavailable.",
    httpStatus: 503,
    retryAfterSeconds: 30
  });
}

function artifactNotFound(): GatewayError {
  return new GatewayError({
    code: "artifact_not_found",
    message: "Research artifact was not found.",
    httpStatus: 404
  });
}

function artifactExpired(): GatewayError {
  return new GatewayError({
    code: "artifact_expired",
    message: "Research artifact has expired.",
    httpStatus: 410
  });
}

function contentDisposition(
  filenameAscii: string,
  filenameUtf8: string
): string {
  const safeAscii =
    filenameAscii.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 255) ||
    "research-artifact";
  const encodedUtf8 = encodeURIComponent(filenameUtf8).replace(
    /['()*]/g,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${safeAscii}"; filename*=UTF-8''${encodedUtf8}`;
}
