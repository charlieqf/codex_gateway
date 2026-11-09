import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { createSubtitleProvider } from "./provider.js";
import type { SubtitleCleaner } from "./clean.js";

const prefix = "/gateway/subtitles/v1";
export const isSubtitleRoute = (url: string) => url.split("?", 1)[0]!.startsWith(prefix + "/");
type Job = { id: string; owner: string; audio: string; created: number; status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "SUBMISSION_UNKNOWN"; task?: number; result?: Record<string, unknown> };
type CleanInput = { job_id: string; version: string; model: "goldencode" | "goldencode-d"; core: { id: number; text: string; words: { id: number; text: string }[] }[]; before: string[]; after: string[]; glossary: { abbreviation: string; full: string }[]; repair?: { message: string; previous: object } };
const fail = (reply: FastifyReply, status: number, code: string) => reply.code(status).send({ error: { code } });
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export function registerSubtitleRoutes(root: FastifyInstance, env: NodeJS.ProcessEnv, provider = createSubtitleProvider(env), clean?: SubtitleCleaner) {
  const directory = env.CODEX_SUBTITLE_STORAGE;
  const pending = new Map<string, Job>();
  const polling = new Set<string>();
  const admissions = new Set<string>();
  const owners = new Map<string, number>();
  const file = (id: string) => path.join(directory!, id + ".json");
  const save = async (job: Job) => {
    const temporary = file(job.id) + "." + randomUUID() + ".tmp";
    await writeFile(temporary, JSON.stringify(job), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file(job.id));
  };
  const load = async (id: string): Promise<Job | undefined> => {
    if (!/^[a-f0-9]{32}$/.test(id)) return;
    return readFile(file(id), "utf8").then(text => JSON.parse(text) as Job).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
  };
  const poll = async (job: Job) => {
    if (polling.has(job.id) || !job.task) return;
    polling.add(job.id);
    try {
      const updated = { ...job };
      // Tencent task IDs expire; never query an old ID that may have been reused.
      if (Date.now() - job.created >= 23 * 3600_000) updated.status = "FAILED";
      else {
        const result = await provider!.tencent("DescribeTaskStatus", { TaskId: job.task });
        if (result.TaskId !== job.task) throw new Error("subtitle_task_mismatch");
        if (result.Status === 2) {
          if (!Array.isArray(result.ResultDetail) || !result.ResultDetail.length || Number(result.AudioDuration) > 600.1) updated.status = "FAILED";
          else { updated.status = "SUCCEEDED"; updated.result = result; }
        } else if (result.Status === 3) updated.status = "FAILED";
        else if (result.Status === 0 || result.Status === 1) updated.status = "RUNNING";
        else throw new Error("subtitle_invalid_status");
      }
      await save(updated);
      if (updated.status === "SUCCEEDED" || updated.status === "FAILED") pending.delete(job.id);
      else pending.set(job.id, updated);
    } catch (error) { root.log.warn({ subtitle_job: job.id, error_code: (error as NodeJS.ErrnoException).code ?? "upstream_error" }, "Subtitle status check failed; retaining the same task"); }
    finally { polling.delete(job.id); }
  };
  void root.register(async app => {
    if (provider && directory) {
      if (!path.isAbsolute(directory)) throw new Error("CODEX_SUBTITLE_STORAGE must be absolute");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      for (const name of await readdir(directory)) {
        if (!/^[a-f0-9]{32}\.json$/.test(name)) continue;
        const job = await load(name.slice(0, 32)).catch(() => {
          root.log.error({ subtitle_job: name.slice(0, 32) }, "Unreadable subtitle job; automatic resubmission disabled");
        });
        if (job?.task && ["PENDING", "RUNNING"].includes(job.status)) pending.set(job.id, job);
      }
      for (const job of pending.values()) void poll(job);
      // Finish and cache remote ASR even when Desktop closes, so later resume does not depend on Tencent's 24-hour retention.
      const timer = setInterval(() => { for (const job of pending.values()) void poll(job); }, 10_000);
      timer.unref();
      app.addHook("onClose", async () => { clearInterval(timer); });
    }
    app.addContentTypeParser("audio/mpeg", { parseAs: "buffer", bodyLimit: 5_000_000 }, (_request, body, done) => done(null, body));
    app.addHook("onRequest", async (request, reply) => {
      reply.header("cache-control", "no-store").header("x-content-type-options", "nosniff");
      const subject = request.gatewayContext?.subject.id;
      if (!subject) return fail(reply, 401, "invalid_credential");
      if (!provider || !directory || !clean) return fail(reply, 503, "subtitle_service_unavailable");
      if (request.headers["content-encoding"]) return fail(reply, 400, "invalid_subtitle_request");
      if (admissions.size >= 8 || (owners.get(subject) ?? 0) >= 2) return fail(reply, 429, "subtitle_busy");
      admissions.add(request.id);
      owners.set(subject, (owners.get(subject) ?? 0) + 1);
    });
    const release = (request: import("fastify").FastifyRequest) => {
      if (!admissions.delete(request.id)) return;
      const subject = request.gatewayContext!.subject.id;
      const count = (owners.get(subject) ?? 1) - 1;
      if (count) owners.set(subject, count); else owners.delete(subject);
    };
    app.addHook("onResponse", async request => { release(request); });
    app.addHook("onRequestAbort", async request => { release(request); });
    app.setErrorHandler((error, _request, reply) => fail(reply, (error as { statusCode?: number }).statusCode === 413 ? 413 : 400, "invalid_subtitle_request"));
    const options = { config: { skipRateLimit: true, skipObservation: true }, logLevel: "silent", bodyLimit: 100_000 } as const;
    app.post(prefix + "/transcriptions", { ...options, bodyLimit: 5_000_000 }, async (request, reply) => {
      const bytes = request.body;
      const key = request.headers["idempotency-key"];
      if (!Buffer.isBuffer(bytes) || !bytes.length || typeof key !== "string" || !/^[a-f0-9]{24}$/.test(key) || digest(bytes) !== request.headers["x-audio-sha256"]) return fail(reply, 400, "invalid_audio_upload");
      const owner = digest(request.gatewayContext!.subject.id);
      const id = digest(owner + ":" + key).slice(0, 32);
      const stored = pending.get(id) ?? await load(id);
      const previous = pending.get(id) ?? stored;
      if (previous) {
        if (previous.audio !== digest(bytes)) return fail(reply, 409, "subtitle_idempotency_conflict");
        return { job_id: id, status: previous.status };
      }
      if (pending.size >= 16) return fail(reply, 429, "subtitle_busy");
      const job: Job = { id, owner, audio: digest(bytes), created: Date.now(), status: "SUBMISSION_UNKNOWN" };
      // Claim before submitting. A transport failure cannot safely be retried as a new paid task.
      pending.set(id, { ...job, status: "PENDING" });
      try {
        await writeFile(file(id), JSON.stringify(job), { flag: "wx", mode: 0o600 });
        const result = await provider!.tencent("CreateRecTask", { EngineModelType: "16k_zh_en_2.0", ChannelNum: 1, ResTextFormat: 3, SourceType: 1, Data: bytes.toString("base64"), DataLen: bytes.length, SpeakerDiarization: 1, FilterDirty: 0, FilterModal: 0, FilterPunc: 0, SentenceMaxLength: 20 });
        if (!Number.isSafeInteger(result.TaskId) || Number(result.TaskId) <= 0) throw new Error("subtitle_invalid_task");
        job.task = Number(result.TaskId);
        job.status = "RUNNING";
        await save(job);
        pending.set(id, job);
        void poll(job);
      } catch {
        pending.delete(id);
        root.log.warn({ subtitle_job: id }, "Subtitle submission unresolved; automatic resubmission disabled");
      }
      return reply.code(202).send({ job_id: id, status: job.status });
    });
    app.get<{ Params: { id: string } }>(prefix + "/transcriptions/:id", options, async (request, reply) => {
      const job = pending.get(request.params.id) ?? await load(request.params.id);
      if (!job || job.owner !== digest(request.gatewayContext!.subject.id)) return fail(reply, 404, "subtitle_not_found");
      return { status: job.status, ...(job.status === "SUCCEEDED" ? { result: job.result } : {}) };
    });
    app.post<{ Body: CleanInput }>(prefix + "/clean", options, async (request, reply) => {
      const input = request.body;
      if (!validCleanInput(input)) return fail(reply, 400, "invalid_cleanup_batch");
      const job = await load(input.job_id);
      if (!job || job.owner !== digest(request.gatewayContext!.subject.id) || job.status !== "SUCCEEDED") return fail(reply, 404, "subtitle_not_found");
      const segments = job.result!.ResultDetail as { FinalSentence: string; Words: { Word: string }[] }[];
      const words = segments.flatMap(segment => segment.Words ?? []).map(word => word.Word);
      if (!input.core.every(unit => segments[unit.id]?.FinalSentence === unit.text && unit.words.every(word => words[word.id] === word.text))) return fail(reply, 400, "subtitle_source_mismatch");
      try { return await clean!(input.model, { core: input.core, before: input.before, after: input.after, glossary: input.glossary, ...(input.repair ? { repair: input.repair } : {}) }, request.gatewayContext!); }
      catch { return fail(reply, 503, "subtitle_clean_failed"); }
    });
  });
}

function validCleanInput(value: unknown): value is CleanInput {
  if (!value || typeof value !== "object") return false;
  const input = value as CleanInput;
  const texts = (items: unknown) => Array.isArray(items) && items.length <= 2 && items.every(text => typeof text === "string" && text.length <= 2000);
  return input.version === "medical-interview-1" && (input.model === "goldencode" || input.model === "goldencode-d") && typeof input.job_id === "string" && /^[a-f0-9]{32}$/.test(input.job_id) &&
    Array.isArray(input.core) && input.core.length > 0 && input.core.length <= 16 &&
    input.core.every(unit => unit && Number.isSafeInteger(unit.id) && unit.id >= 0 && typeof unit.text === "string" && Array.isArray(unit.words) && unit.words.length > 0 && unit.words.length <= 1000 && unit.words.every(word => word && Number.isSafeInteger(word.id) && word.id >= 0 && typeof word.text === "string" && word.text.length <= 200)) &&
    input.core.reduce((total, unit) => total + unit.text.length, 0) <= 2000 && texts(input.before) && texts(input.after) &&
    Array.isArray(input.glossary) && input.glossary.length <= 300 && input.glossary.every(term => term && typeof term.abbreviation === "string" && term.abbreviation.length <= 30 && typeof term.full === "string" && term.full.length <= 120) &&
    (input.repair === undefined || input.repair && typeof input.repair.message === "string" && input.repair.message.length <= 2000 && input.repair.previous !== null && typeof input.repair.previous === "object");
}
