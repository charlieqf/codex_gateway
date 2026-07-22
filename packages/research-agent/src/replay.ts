import { createHash } from "node:crypto";
import type { DoctorResearchRunInput } from "@codex-gateway/core";
import {
  doctorResearchSkillDefinition
} from "./skill-definition.js";
import {
  replayDoctorResearchSynthesis,
  type DoctorResearchSynthesisReplayCall,
  type DoctorResearchSynthesisReplayArtifact,
  type ResolvedDoctorResearchIdentity,
  type WorkflowEvidence
} from "./workflow.js";

export const doctorResearchReplayFixtureVersion =
  "doctor_research_replay_fixture.v1";
export const doctorResearchReplayResponseTemplateVersion =
  "doctor_research_synthetic_response.v1";

export type DoctorResearchReplayErrorCode =
  | "provider_500"
  | "rate_limited"
  | "timeout"
  | "client_abort";

export type DoctorResearchReplaySyntheticVariant =
  | "valid"
  | "short_topic"
  | "orphaned_demonstrative"
  | "truncated_comparison"
  | "qa_after_conclusion"
  | "unsupported_numeric"
  | "missing_citation"
  | "peer_patch"
  | "shard_json_failure";

export interface DoctorResearchReplayFixture {
  fixture_version: typeof doctorResearchReplayFixtureVersion;
  fixture_id: string;
  fixture_kind: "synthetic_derived";
  skill_bundle_sha256: string;
  prompt_version: string;
  validation_version: string;
  workflow_version: string;
  response_template_version:
    typeof doctorResearchReplayResponseTemplateVersion;
  run_input: DoctorResearchRunInput;
  closed_evidence: {
    identity: ResolvedDoctorResearchIdentity;
    evidence: WorkflowEvidence;
  };
  model_calls: Array<{
    stage: "synthesize_review" | "validate_outputs";
    attempt: number;
    role: DoctorResearchSynthesisReplayCall["role"];
    response_or_error:
      | {
          type: "synthetic_response";
          variant: DoctorResearchReplaySyntheticVariant;
        }
      | { type: "response"; text: string }
      | { type: "error"; code: DoctorResearchReplayErrorCode };
  }>;
  expected: {
    terminal_status: "succeeded" | "failed" | "cancelled";
    diagnostics: string[];
    artifact_semantics: {
      exact_kinds: ["profile", "review", "questions", "answers"];
      markdown_count: 3;
      text_count: 1;
      deterministic_content_sha256: boolean;
      aggregate_content_sha256: string | null;
    };
  };
}

export interface DoctorResearchReplayResult {
  terminalStatus: "succeeded" | "failed" | "cancelled";
  diagnostics: string[];
  warnings: string[];
  artifacts: DoctorResearchSynthesisReplayArtifact[];
  artifactContentSha256: string | null;
}

export function runDoctorResearchReplayFixture(input: {
  fixture: DoctorResearchReplayFixture;
  activeSkillBundleSha256: string;
  now?: Date;
}): DoctorResearchReplayResult {
  validateReplayFixture(input.fixture, input.activeSkillBundleSha256);
  const terminalError = input.fixture.model_calls.find(
    (call) => call.response_or_error.type === "error"
  );
  if (
    terminalError &&
    terminalError.response_or_error.type === "error"
  ) {
    const code = terminalError.response_or_error.code;
    return {
      terminalStatus: code === "client_abort" ? "cancelled" : "failed",
      diagnostics: [replayErrorDiagnostic(code)],
      warnings: [],
      artifacts: [],
      artifactContentSha256: null
    };
  }
  const modelCalls = input.fixture.model_calls.map((call) => {
    const result = call.response_or_error;
    if (result.type === "error") {
      throw new Error("Unreachable Research replay error state.");
    }
    return {
      stage: call.stage,
      attempt: call.attempt,
      role: call.role,
      responseText:
        result.type === "response"
          ? result.text
          : syntheticReplayResponse(
              call.role,
              result.variant,
              input.fixture.closed_evidence.evidence
            )
    } satisfies DoctorResearchSynthesisReplayCall;
  });
  const replay = replayDoctorResearchSynthesis({
    runInput: input.fixture.run_input,
    runId: `drr_${createHash("sha256")
      .update(input.fixture.fixture_id, "utf8")
      .digest("hex")
      .slice(0, 32)}`,
    now: input.now ?? new Date("2026-07-22T00:00:00.000Z"),
    identity: input.fixture.closed_evidence.identity,
    closedEvidence: input.fixture.closed_evidence.evidence,
    policy: productionReplayPolicy(),
    modelCalls
  });
  const artifacts = replay.artifacts;
  return {
    terminalStatus: replay.terminalStatus,
    diagnostics: replay.diagnostics,
    warnings: replay.warnings,
    artifacts,
    artifactContentSha256:
      artifacts.length === 0
        ? null
        : createHash("sha256")
            .update(
              artifacts
                .map(
                  (artifact) =>
                    `${artifact.kind}\u0000${artifact.contentSha256}`
                )
                .join("\n"),
              "utf8"
            )
            .digest("hex")
  };
}

function validateReplayFixture(
  fixture: DoctorResearchReplayFixture,
  activeSkillBundleSha256: string
): void {
  if (
    fixture.fixture_version !== doctorResearchReplayFixtureVersion ||
    fixture.response_template_version !==
      doctorResearchReplayResponseTemplateVersion ||
    !/^doctor_research_replay_[a-z0-9_]{3,80}$/u.test(
      fixture.fixture_id
    ) ||
    fixture.fixture_kind !== "synthetic_derived"
  ) {
    throw new Error("Doctor Research replay fixture metadata is invalid.");
  }
  if (
    !/^[a-f0-9]{64}$/u.test(fixture.skill_bundle_sha256) ||
    fixture.skill_bundle_sha256 !== activeSkillBundleSha256
  ) {
    throw new Error(
      "Doctor Research replay fixture Skill bundle digest requires review."
    );
  }
  if (
    fixture.prompt_version !== doctorResearchSkillDefinition.promptVersion ||
    fixture.validation_version !==
      doctorResearchSkillDefinition.validationPolicyVersion ||
    fixture.workflow_version !==
      doctorResearchSkillDefinition.workflowPolicyVersion
  ) {
    throw new Error(
      "Doctor Research replay fixture policy versions are stale."
    );
  }
  if (
    fixture.run_input.language !== "zh-CN" ||
    fixture.run_input.mode !== "brief" ||
    fixture.model_calls.length === 0 ||
    fixture.model_calls.length > 5 ||
    new Set(
      fixture.model_calls.map(
        (call) => `${call.stage}:${call.attempt}:${call.role}`
      )
    ).size !== fixture.model_calls.length
  ) {
    throw new Error("Doctor Research replay fixture input is invalid.");
  }
  const semantics = fixture.expected.artifact_semantics;
  if (
    semantics.markdown_count !== 3 ||
    semantics.text_count !== 1 ||
    semantics.deterministic_content_sha256 !== true ||
    (semantics.aggregate_content_sha256 !== null &&
      !/^[a-f0-9]{64}$/u.test(semantics.aggregate_content_sha256)) ||
    semantics.exact_kinds.join(",") !==
      "profile,review,questions,answers"
  ) {
    throw new Error(
      "Doctor Research replay artifact expectations are invalid."
    );
  }
}

function replayErrorDiagnostic(code: DoctorResearchReplayErrorCode): string {
  return {
    provider_500: "model_upstream_error_500",
    rate_limited: "model_rate_limited",
    timeout: "model_timeout_cancelled",
    client_abort: "client_aborted"
  }[code];
}

function syntheticReplayResponse(
  role: DoctorResearchSynthesisReplayCall["role"],
  variant: DoctorResearchReplaySyntheticVariant,
  evidence: WorkflowEvidence
): string {
  if (variant === "shard_json_failure") {
    return "{\"schema_version\":\"broken";
  }
  if (role === "peer_review") {
    return JSON.stringify({
      schema_version: "doctor_research_peer_review.v1",
      approved: true,
      replacements:
        variant === "peer_patch"
          ? [
              {
                target: "markdown",
                old_text: "证据边界短语",
                new_text: "证据适用边界短语"
              }
            ]
          : [],
      warnings: []
    });
  }
  if (role === "complete_draft") {
    throw new Error(
      "Synthetic Research replay templates use sharded responses."
    );
  }
  if (role === "foundation") {
    return JSON.stringify(syntheticFoundationFragment());
  }
  if (role === "body") {
    const body = syntheticBodyFragment(evidence);
    body.markdown = mutateBodyMarkdown(body.markdown, variant);
    return JSON.stringify(body);
  }
  const closing = syntheticClosingFragment();
  if (variant === "qa_after_conclusion") {
    closing.markdown +=
      "\n\n## 附加问答\n\n问题：是否可以直接用于诊疗？回答：不能替代专业判断。[1-3]";
  }
  return JSON.stringify(closing);
}

function syntheticFoundationFragment() {
  const abstractSeed =
    "本综述以经过核验的公开元数据与摘要为证据边界，围绕示例研究主题梳理研究对象、设计方法、观察结局与解释限制。现有资料可支持对研究路径和证据一致性的结构化讨论，但摘要未披露的信息不作为事实，也不把观察性关联解释为因果关系。不同来源在研究问题、资料基础、方法选择和适用范围上具有互补性，仍需结合全文开展质量评价与独立复核。";
  return {
    schema_version: "doctor_research_foundation_fragment.v3",
    review: {
      title: "示例研究主题的证据路径与方法学边界综述",
      abstract: repeatToMinimum(abstractSeed, 340),
      keywords: ["示例研究", "证据综合", "方法学", "研究边界"],
      markdown: [
        "## 引言",
        "",
        "证据边界短语用于标记本次回放的精确补丁位置。[1-3]",
        repeatToMinimum(
          "引言部分从研究问题、资料来源、设计能力、方法路径和结局解释等维度建立后续综合框架。公开摘要能够提供可追溯的研究线索，但无法替代全文对纳入过程、偏倚控制和外部适用性的判断。跨研究比较应同时保留共同发现与限制条件，避免把统计关联、技术可行性或预测表现直接改写为普遍临床获益。当前材料用于形成审慎的学术证据地图，并为后续主题综合、争议识别和全文复核提供起点。[1-3]",
          1_050
        )
      ].join("\n")
    }
  };
}

function syntheticBodyFragment(evidence: WorkflowEvidence) {
  const citations = `[1-${Math.max(1, evidence.references.length)}]`;
  const topics = [
    ["研究对象与问题界定", "本节比较研究对象和核心问题的界定方式"],
    ["设计能力与资料来源", "本节讨论设计能力、资料来源与偏倚边界"],
    ["方法路径与结局解释", "本节梳理方法路径、观察结局与解释强度"],
    ["证据一致性与适用范围", "本节评估证据一致性、差异来源与适用范围"]
  ];
  const markdown = topics
    .map(([heading, lead]) =>
      section(
        heading!,
        `${lead}。所引公开摘要共同提供了可复核的研究线索，而各自的研究目的、资料基础、方法选择和结局口径仍需分别理解。横向综合既呈现能够相互印证的部分，也保留样本来源、测量框架和分析策略造成的不确定性；观察性证据只支持关联层面的审慎表述，不能据此推断因果。摘要没有披露的过程不作补写，技术可行性、预测表现与临床效果也保持不同的证据等级。由此形成的结论用于定位研究问题和后续验证需求，而不是脱离原文作确定性推广。${citations}`,
        760
      )
    )
    .join("\n\n");
  const questions = [
    "这些研究的证据边界是什么？",
    "不同设计为何不能直接合并？",
    "方法差异会怎样影响解释？",
    "目前哪些结论仍需全文核验？",
    "后续研究应优先补足什么？"
  ];
  return {
    schema_version: "doctor_research_body_fragment.v1",
    markdown,
    predicted_questions: questions,
    answers: questions.map((_, index) => ({
      question_index: index + 1,
      answer: syntheticAnswer(index),
      source_ids: evidence.sources
        .filter((source) => source.source_type === "pubmed")
        .slice(0, 3)
        .map((source) => source.source_id)
    }))
  };
}

function syntheticAnswer(index: number): string {
  const openings = [
    "证据边界应限定在经过核验的公开摘要范围内。",
    "不同设计需要按照各自能够回答的研究问题分层理解。",
    "方法差异会改变资料来源、测量框架和结局解释。",
    "仍需全文核验的内容包括偏倚控制和外部适用性。",
    "后续研究应优先补足完整方法学评价与独立验证。"
  ];
  return [
    openings[index]!,
    "现有材料能够支持研究问题、设计能力、方法路径与证据一致性的结构化比较，但不能替代对全文、补充材料和分析方案的审阅。",
    "观察性关联不能据此推断因果，摘要未披露的信息也不作补写；因此更稳妥的用途是定位证据、识别争议并规划后续复核。"
  ].join("");
}

function syntheticClosingFragment() {
  return {
    schema_version: "doctor_research_review_fragment.v1",
    markdown: [
      section(
        "证据综合与未解争议",
        "证据综合需要按照研究问题、对象范围、设计能力、资料来源、方法路径和结局定义分层，而不能只比较摘要结论的措辞。相互印证的发现应保留共同边界，方向不一致的内容则回到纳入来源、测量方式、观察框架和分析处理逐项解释。公开摘要未披露的环节不补写为事实，也不把统计关联、技术可行性或预测表现直接提升为因果结论。当前资料可以形成可追溯的证据地图，但未解争议仍包括选择过程、偏倚控制、缺失资料、亚组设定、结局确认和外部适用性，这些问题需要全文复核、前瞻性研究、外部验证或独立重复进一步回答。[1-3]",
        1_050
      ),
      section(
        "局限性与展望",
        "本次产物以核验后的公开元数据与摘要为直接证据边界，因此无法替代对全文、补充材料、研究方案和分析计划的审阅。摘要压缩了纳入排除标准、基线差异、失访处理、敏感性分析和不良事件定义，未披露内容不能借助相邻研究、题名或期刊信息推定。纳入记录之间还可能存在对象、中心来源、技术路线、比较条件、观察窗口与终点口径差异，即使方向接近，也会限制直接合并和跨人群外推。后续应优先取得全文并复核方案、统计方法、偏倚控制和长期结局，同时关注外部验证与独立重复。[1-3]",
        820
      ),
      section(
        "结论",
        "现有公开证据支持建立结构化且可复核的研究脉络，并识别设计、方法、结局与证据等级之间的联系和差异。结论始终限定在所引研究明确报告的范围内，不把摘要缺失的信息补写为事实，也不把关联性、预测性能或技术可行性越级解释为确定因果和普遍临床获益。这份综述适合用于定位证据、核对原文和规划后续验证；正式学术判断仍需结合全文、持续更新的研究证据与独立专业评价。[1-3]",
        420
      )
    ].join("\n\n")
  };
}

function mutateBodyMarkdown(
  markdown: string,
  variant: DoctorResearchReplaySyntheticVariant
): string {
  if (variant === "short_topic") {
    return replaceSectionBody(
      markdown,
      "设计能力与资料来源",
      "该主题内容过短，仅保留概括性判断。[1-3]"
    );
  }
  if (variant === "orphaned_demonstrative") {
    return replaceSectionBody(
      markdown,
      "设计能力与资料来源",
      sectionBody(markdown, "设计能力与资料来源").replace(
        /^/u,
        "该研究提示了关联。"
      )
    );
  }
  if (variant === "truncated_comparison") {
    return replaceSectionBody(
      markdown,
      "设计能力与资料来源",
      `${sectionBody(markdown, "设计能力与资料来源")} 与另一研究相比。`
    );
  }
  if (variant === "unsupported_numeric") {
    return replaceSectionBody(
      markdown,
      "设计能力与资料来源",
      `${sectionBody(markdown, "设计能力与资料来源")} 该方法报告的数值为 99.9%，但所引摘要没有这一数值。[1]`
    );
  }
  if (variant === "missing_citation") {
    return replaceSectionBody(
      markdown,
      "设计能力与资料来源",
      sectionBody(markdown, "设计能力与资料来源").replace(
        /\[[0-9,\s-]+\]/gu,
        ""
      )
    );
  }
  return markdown;
}

function section(heading: string, seed: string, minimum: number): string {
  return `## ${heading}\n\n${repeatToMinimum(seed, minimum)}`;
}

function repeatToMinimum(seed: string, minimum: number): string {
  let value = seed.trim();
  while (Array.from(value.replace(/\[[0-9,\s-]+\]/gu, "")).length < minimum) {
    value += ` ${seed.trim()}`;
  }
  return value;
}

function sectionBody(markdown: string, heading: string): string {
  const pattern = new RegExp(
    `## ${escapeRegExp(heading)}\\n\\n([\\s\\S]*?)(?=\\n\\n## |$)`,
    "u"
  );
  const match = pattern.exec(markdown);
  if (!match) {
    throw new Error(`Synthetic replay section is missing: ${heading}`);
  }
  return match[1]!;
}

function replaceSectionBody(
  markdown: string,
  heading: string,
  replacement: string
): string {
  const body = sectionBody(markdown, heading);
  return markdown.replace(
    `## ${heading}\n\n${body}`,
    `## ${heading}\n\n${replacement}`
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function productionReplayPolicy() {
  return {
    resultTtlSeconds: 2_592_000,
    maximumArtifactBytes: 1_048_576,
    maximumRunArtifactBytes: 4_194_304,
    maximumExternalResponseBytesPerCall: 2_000_000,
    maximumSourceTextCharacters: 200_000,
    maximumPublications: 40,
    minimumReferences: 3,
    minimumReviewContent: 6_000,
    maximumQuestionContent: 30,
    minimumAnswerContent: 100,
    maximumAnswerContent: 300,
    maximumInputTokensPerCall: 40_000,
    maximumOutputTokensPerCall: 18_000,
    hardDeadlineMs: 570_000,
    synthesisShardCount: 3 as const,
    budgets: {
      externalRequests: 908,
      externalResponseBytes: 1_816_000_000,
      llmCalls: 5,
      inputTokens: 200_000,
      outputTokens: 90_000
    },
    forbiddenOutputFragments: [
      "ignore all prior instructions",
      "reveal api key",
      "system prompt"
    ]
  };
}
