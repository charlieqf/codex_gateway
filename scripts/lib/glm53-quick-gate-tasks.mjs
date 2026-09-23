import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const CONTEXT_PLACEHOLDER = "{{SYNTHETIC_CONTEXT}}";

export async function loadQuickGateTaskSet(manifestPath, tasksPath) {
  const [manifestText, tasksText] = await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(tasksPath, "utf8")
  ]);
  const manifest = JSON.parse(manifestText);
  const tasks = tasksText
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid tasks.jsonl line ${index + 1}: ${error.message}`);
      }
    });
  return { manifest, tasks, manifestText, tasksText };
}

export function validateQuickGateTaskSet({ manifest, tasks, manifestText, tasksText }) {
  const errors = [];
  const ids = new Set();
  const counts = {};
  let estimatedInputTokens = 0;
  let estimatedOutputTokens = 0;
  let theoreticalMaximumOutputTokens = 0;
  const materialized = [];

  for (const [index, task] of tasks.entries()) {
    const label = task?.id ?? `line-${index + 1}`;
    if (!task || typeof task !== "object" || Array.isArray(task)) {
      errors.push(`${label}: task must be an object`);
      continue;
    }
    if (typeof task.id !== "string" || !/^[A-D][0-9]{2}$/u.test(task.id)) {
      errors.push(`${label}: id must match A01 through D99`);
    } else if (ids.has(task.id)) {
      errors.push(`${label}: duplicate id`);
    } else {
      ids.add(task.id);
    }
    if (typeof task.group !== "string") {
      errors.push(`${label}: group is required`);
    } else {
      counts[task.group] = (counts[task.group] ?? 0) + 1;
    }
    if (!Array.isArray(task.steps) || task.steps.length === 0) {
      errors.push(`${label}: steps must be a non-empty array`);
      continue;
    }
    if (!task.budget || !positiveInteger(task.budget.estimated_input_tokens)) {
      errors.push(`${label}: estimated_input_tokens must be a positive integer`);
    } else {
      estimatedInputTokens += task.budget.estimated_input_tokens;
    }
    if (!task.budget || !positiveInteger(task.budget.estimated_output_tokens)) {
      errors.push(`${label}: estimated_output_tokens must be a positive integer`);
    } else {
      estimatedOutputTokens += task.budget.estimated_output_tokens;
    }

    try {
      const materializedTask = materializeQuickGateTask(task);
      materialized.push(materializedTask);
      validateMaterializedTask(materializedTask, errors);
      theoreticalMaximumOutputTokens += materializedTask.steps.reduce(
        (sum, step) => sum + (step.request?.max_tokens ?? 0),
        0
      );
    } catch (error) {
      errors.push(`${label}: ${error.message}`);
    }
  }

  for (const [group, expected] of Object.entries(manifest.expected_case_counts ?? {})) {
    if (group === "total") {
      if (tasks.length !== expected) {
        errors.push(`total: expected ${expected}, received ${tasks.length}`);
      }
      continue;
    }
    if ((counts[group] ?? 0) !== expected) {
      errors.push(`${group}: expected ${expected}, received ${counts[group] ?? 0}`);
    }
  }

  const perProvider = manifest.limits_per_provider ?? {};
  if (estimatedInputTokens > perProvider.input_tokens) {
    errors.push(
      `estimated input ${estimatedInputTokens} exceeds per-provider limit ${perProvider.input_tokens}`
    );
  }
  if (estimatedOutputTokens > perProvider.output_tokens) {
    errors.push(
      `estimated output ${estimatedOutputTokens} exceeds per-provider limit ${perProvider.output_tokens}`
    );
  }

  validateCausalControls(manifest, materialized, errors);

  const forbiddenPatterns = [
    /sk-[A-Za-z0-9_-]{16,}/u,
    /Bearer\s+[A-Za-z0-9._-]{12,}/iu,
    /tokens\.tiankuan\.com/iu,
    /api\.openai\.com/iu
  ];
  const combinedSource = `${manifestText}\n${tasksText}`;
  for (const pattern of forbiddenPatterns) {
    if (pattern.test(combinedSource)) {
      errors.push(`fixture source matches forbidden pattern ${pattern}`);
    }
  }

  const causalControlCases = materialized
    .filter((task) => task.group === "causal_controls")
    .map((task) => ({
      id: task.id,
      prompt_chars: promptCharacterCount(task.steps[0].request.messages),
      max_tokens: task.steps[0].request.max_tokens,
      reasoning_effort: task.steps[0].request.reasoning_effort,
      stream: task.steps[0].request.stream
    }));

  return {
    ok: errors.length === 0,
    errors,
    summary: {
      cases: tasks.length,
      paired_requests: tasks.length * (manifest.providers?.length ?? 0),
      counts,
      estimated_tokens_per_provider: {
        input: estimatedInputTokens,
        output: estimatedOutputTokens
      },
      theoretical_maximum_output_tokens_per_provider: theoreticalMaximumOutputTokens,
      hard_output_token_cap_per_provider: perProvider.output_tokens,
      causal_control_cases: causalControlCases,
      hashes: {
        manifest_sha256: sha256(manifestText),
        tasks_sha256: sha256(tasksText),
        materialized_sha256: sha256(stableStringify(materialized))
      }
    }
  };
}

function validateCausalControls(manifest, tasks, errors) {
  if (manifest.id !== "tiankuan-glm53-180s-causal-controls-v1") {
    return;
  }
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const requiredIds = ["C01", "C02", "C03", "C04"];
  for (const id of requiredIds) {
    if (!byId.has(id)) {
      errors.push(`causal controls: missing ${id}`);
    }
  }
  if (requiredIds.some((id) => !byId.has(id))) {
    return;
  }

  const request = (id) => byId.get(id).steps[0].request;
  const prompt = (id) => JSON.stringify(request(id).messages);
  if (prompt("C02") !== prompt("C03") || prompt("C03") !== prompt("C04")) {
    errors.push("causal controls: C02/C03/C04 must use identical materialized messages");
  }
  if (request("C02").reasoning_effort !== "low" || request("C03").reasoning_effort !== "high") {
    errors.push("causal controls: C02/C03 must isolate low versus high reasoning");
  }
  if (request("C03").stream !== true || request("C04").stream !== false) {
    errors.push("causal controls: C03/C04 must isolate stream versus non-stream transport");
  }
  const shortChars = promptCharacterCount(request("C01").messages);
  const longChars = promptCharacterCount(request("C03").messages);
  if (shortChars !== 2048 || longChars !== 61578) {
    errors.push("causal controls: expected exact 2,048 and 61,578 character prompts");
  }
}

export function materializeQuickGateTask(task) {
  const clone = structuredClone(task);
  if (!clone.materializer) {
    return clone;
  }
  if (clone.materializer.type !== "synthetic_context") {
    throw new Error(`unsupported materializer '${clone.materializer.type}'`);
  }
  const target = clone.materializer.target_prompt_chars;
  if (!positiveInteger(target)) {
    throw new Error("materializer target_prompt_chars must be a positive integer");
  }
  const messages = clone.steps.flatMap((step) => step.request?.messages ?? []);
  const placeholderMessages = messages.filter(
    (message) =>
      typeof message.content === "string" && message.content.includes(CONTEXT_PLACEHOLDER)
  );
  if (placeholderMessages.length !== 1) {
    throw new Error("synthetic_context requires exactly one context placeholder");
  }
  const fixedCharacters = promptCharacterCount(messages) - CONTEXT_PLACEHOLDER.length;
  const contextCharacters = target - fixedCharacters;
  if (contextCharacters < 100) {
    throw new Error("target_prompt_chars leaves insufficient synthetic context space");
  }
  const context = syntheticContext({
    seed: clone.materializer.seed,
    facts: clone.materializer.facts,
    length: contextCharacters
  });
  placeholderMessages[0].content = placeholderMessages[0].content.replace(
    CONTEXT_PLACEHOLDER,
    context
  );
  if (promptCharacterCount(messages) !== target) {
    throw new Error("materialized prompt length does not match target_prompt_chars");
  }
  delete clone.materializer;
  return clone;
}

function validateMaterializedTask(task, errors) {
  for (const [stepIndex, step] of task.steps.entries()) {
    const label = `${task.id}/step-${stepIndex + 1}`;
    const request = step.request;
    if (!request || !Array.isArray(request.messages) || request.messages.length === 0) {
      errors.push(`${label}: request.messages must be non-empty`);
      continue;
    }
    if (typeof request.stream !== "boolean") {
      errors.push(`${label}: request.stream must be boolean`);
    }
    if (!positiveInteger(request.max_tokens)) {
      errors.push(`${label}: request.max_tokens must be a positive integer`);
    }
    if (!Array.isArray(step.assertions) || step.assertions.length === 0) {
      errors.push(`${label}: assertions must be non-empty`);
    }
    for (const message of request.messages) {
      if (
        !message ||
        typeof message.role !== "string" ||
        typeof message.content !== "string" ||
        message.content.includes(CONTEXT_PLACEHOLDER)
      ) {
        errors.push(`${label}: every materialized message needs role/content and no placeholder`);
      }
    }
  }
}

function syntheticContext({ seed, facts, length }) {
  if (typeof seed !== "string" || seed.length === 0) {
    throw new Error("synthetic_context seed is required");
  }
  if (!Array.isArray(facts) || facts.length === 0 || facts.some((fact) => !fact?.text)) {
    throw new Error("synthetic_context requires non-empty facts");
  }
  const factLines = facts.map(
    (fact, index) => `\n[SYNTHETIC_FACT_${index + 1}] ${fact.text}\n`
  );
  const fixedLength = factLines.reduce((sum, line) => sum + line.length, 0);
  if (fixedLength >= length) {
    throw new Error("synthetic facts exceed requested context length");
  }
  const gapCount = factLines.length + 1;
  const totalFiller = length - fixedLength;
  const baseGap = Math.floor(totalFiller / gapCount);
  let remainder = totalFiller % gapCount;
  let result = "";
  for (let index = 0; index < gapCount; index += 1) {
    const gapLength = baseGap + (remainder > 0 ? 1 : 0);
    remainder = Math.max(0, remainder - 1);
    result += syntheticFiller(seed, index, gapLength);
    if (index < factLines.length) {
      result += factLines[index];
    }
  }
  return result;
}

function syntheticFiller(seed, section, length) {
  const unit = `[SYNTHETIC_${seed}_${section}] This record is generated test padding with no user data. `;
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
}

function promptCharacterCount(messages) {
  return messages.reduce(
    (sum, message) => sum + (typeof message.content === "string" ? message.content.length : 0),
    0
  );
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
