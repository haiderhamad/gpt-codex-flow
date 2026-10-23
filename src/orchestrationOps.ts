/** Deterministic lead recommendation: no model API calls or agent execution. */
export type OrchestratorMode = "chatgpt_lead" | "codex_lead" | "auto";
export type LeadMode = Exclude<OrchestratorMode, "auto">;
/** Advisory task configuration. The bridge does not invoke or configure Codex. */
export type CodexReasoningEffort = "auto" | "low" | "medium" | "high" | "xhigh";
export type CodexAvailability = "unknown" | "available" | "rate_limited" | "context_exhausted" | "unavailable";
export interface CodexTaskPreferences {
  codex_model?: string;
  reasoning_effort?: CodexReasoningEffort;
  /** Caller-reported status; no plan/quota introspection or automatic model invocation. */
  codex_availability?: CodexAvailability;
}

export interface OrchestrationPlan {
  requested_mode: OrchestratorMode;
  recommended_mode: LeadMode;
  proposed_mode: LeadMode;
  recommendation_reason: string;
  matched_signals: { chatgpt: string[]; codex: string[] };
  confirmation_required: boolean;
  selection_persisted: false;
  execution_started: false;
  transfer_performed: false;
  codex_model: string | null;
  requested_reasoning_effort: CodexReasoningEffort;
  recommended_reasoning_effort: Exclude<CodexReasoningEffort,"auto">;
  proposed_reasoning_effort: Exclude<CodexReasoningEffort,"auto">;
  reasoning_recommendation_reason: string;
  codex_model_applied: false;
  reasoning_effort_applied: false;
  codex_availability_reported: CodexAvailability;
  coding_handoff_recommended: boolean;
  chatgpt_lead_can_code: true;
  chatgpt_coding_requires_write_permission: true;
  chatgpt_session_started: false;
}

const CHATGPT_SIGNALS = [
  "architecture", "architect", "design", "strategy", "research", "compare",
  "tradeoff", "requirements", "planning", "plan", "review", "analysis",
  "explain", "security review", "معمارية", "تصميم", "خطة", "خطط", "قارن", "راجع", "بحث"
];
const CODEX_SIGNALS = [
  "implement", "code", "coding", "fix", "debug", "bug", "refactor",
  "test", "tests", "typescript", "javascript", "backend", "frontend",
  "build", "compile", "migration", "unit test", "integration test",
  "نفذ", "برمجة", "كود", "اصلح", "اختبر", "عدّل", "عدل"
];

function matched(goal: string, terms: string[]): string[] {
  const searchable = " " + goal.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ") + " ";
  return terms.filter((term) => searchable.includes(" " + term + " "));
}

/** Recommend task effort without using a model or guessing subscription access. */
export function planOrchestration(
  goal: string,
  mode: OrchestratorMode = "auto",
  preferences: CodexTaskPreferences = {}
): OrchestrationPlan {
  if (!goal.trim()) throw new Error("A nonempty goal is required.");
  if (goal.length > 2000) throw new Error("Goal must be at most 2000 characters.");
  if (!["chatgpt_lead", "codex_lead", "auto"].includes(mode)) {
    throw new Error("Unknown orchestration mode.");
  }
  const model = preferences.codex_model?.trim() || null;
  if (model && (model.length > 80 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model))) {
    throw new Error("Codex model must be a valid bounded model identifier.");
  }
  const requested = preferences.reasoning_effort ?? "auto";
  if (!["auto", "low", "medium", "high", "xhigh"].includes(requested)) {
    throw new Error("Unknown Codex reasoning effort.");
  }
  const availability = preferences.codex_availability ?? "unknown";
  if (!["unknown", "available", "rate_limited", "context_exhausted", "unavailable"].includes(availability))
    throw new Error("Unknown Codex availability status.");
  const codexBlocked = ["rate_limited","context_exhausted","unavailable"].includes(availability);
  const normalized = goal.toLocaleLowerCase();
  const complicated = /security|threat|audit|architecture|architect|design system|migration|complex|refactor|orchestrat|release|broker|authentication|multi.agent|معمارية|أمان|امن|مراجعة أمنية|هندسة/.test(normalized);
  const tiny = /^(?:fix typo|rename|format|spellcheck|update comment|تصحيح كتابة)/.test(normalized.trim());
  const effort = complicated ? "high" : tiny ? "low" : "medium";
  const effortReason = complicated ? "Complexity or security-related signals; suggest deeper review."
    : tiny ? "Small mechanical task; suggest lower latency."
    : "Typical development task; suggest balanced effort.";
  const chatgpt = matched(goal, CHATGPT_SIGNALS);
  const codex = matched(goal, CODEX_SIGNALS);
  const recommended_mode: LeadMode = codexBlocked ? "chatgpt_lead" :
    codex.length > chatgpt.length ? "codex_lead" : "chatgpt_lead";
  const reason = codexBlocked
    ? "Codex was reported unavailable for this run; recommend ChatGPT for coding and verification with explicitly granted workspace edit/test tools. This does not bypass account quotas or start ChatGPT."
    : chatgpt.length === 0 && codex.length === 0
      ? "No clear coding or planning signals; default to ChatGPT for initial scoping."
      : chatgpt.length === codex.length
        ? "Signals are balanced; start with ChatGPT to clarify scope."
        : recommended_mode === "codex_lead"
          ? "More implementation and verification signals than planning signals."
          : "More planning and review signals than implementation signals.";
  return {
    requested_mode: mode,
    recommended_mode,
    proposed_mode: codexBlocked ? "chatgpt_lead" : mode === "auto" ? recommended_mode : mode,
    recommendation_reason: reason,
    matched_signals: { chatgpt, codex },
    confirmation_required: mode === "auto" || (codexBlocked && mode === "codex_lead"),
    selection_persisted: false,
    execution_started: false,
    transfer_performed: false,
    codex_model: model,
    requested_reasoning_effort: requested,
    recommended_reasoning_effort: effort,
    proposed_reasoning_effort: requested === "auto" ? effort : requested,
    reasoning_recommendation_reason: effortReason,
    codex_model_applied: false,
    reasoning_effort_applied: false,
    codex_availability_reported: availability,
    coding_handoff_recommended: codexBlocked,
    chatgpt_lead_can_code: true,
    chatgpt_coding_requires_write_permission: true,
    chatgpt_session_started: false
  };
}
