/**
 * One switch for the AI layer: USE_AI=true (and a GEMINI_API_KEY) turns on
 * Gemini for constraint extraction, day assignment and narration. With AI off,
 * or when a call fails (rate limit, network), each step falls back to its
 * deterministic twin — rules, heuristic, templates — so the app always works.
 *
 * LLM calls per plan: extract (1) + assign (1, +1 retry if needed) + narrate (1) ≤ 4.
 */
import { type Catalogue, loadCatalogue } from "../catalogue";
import { isAIEnabled, type LLMMeta } from "../llm";
import { assignDaysHeuristic } from "../planner/assignDays";
import { type PipelineResult, runPipeline } from "../planner/pipeline";
import type { Constraint, TripInput } from "../types";
import { type AIAssignReport, makeAIAssign } from "./assignDays";
import { type ExtractContext, type ExtractResult, extractConstraintsAI, extractConstraintsRules } from "./extractConstraints";
import { type NarrationReport, narratePlan } from "./narrate";

export type AIRunReport = {
  aiEnabled: boolean;
  calls: LLMMeta[];
  fallbacks: string[];
  assign?: AIAssignReport;
  narration?: NarrationReport;
};

export async function extractFromChat(
  message: string,
  current: Constraint[],
  context: ExtractContext,
  catalogue: Catalogue = loadCatalogue(),
): Promise<ExtractResult & { fallback?: string }> {
  if (!isAIEnabled()) return extractConstraintsRules(message, current, catalogue);
  try {
    return await extractConstraintsAI(message, current, context, catalogue);
  } catch (e) {
    const r = extractConstraintsRules(message, current, catalogue);
    return { ...r, fallback: `AI extraction unavailable (${(e as Error).message.slice(0, 120)}); used rules` };
  }
}

/** Plan a trip end to end: pipeline (AI or heuristic assignment) + narration (AI or templates). */
export async function planTrip(
  input: TripInput,
  chatConstraints: Constraint[],
  opts: { locked?: Record<number, string[]>; catalogue?: Catalogue } = {},
): Promise<PipelineResult & { ai: AIRunReport }> {
  const catalogue = opts.catalogue ?? loadCatalogue();
  const aiEnabled = isAIEnabled();
  const report: AIRunReport = { aiEnabled, calls: [], fallbacks: [] };

  const preferences = chatConstraints.filter((c) => c.type === "freeform").map((c) => (c.params as { text: string }).text);
  const assignReport: AIAssignReport = { calls: [], notes: [], fallbackDays: [], fullFallback: false };
  const assignFn = aiEnabled ? makeAIAssign({ locked: opts.locked, preferences, report: assignReport }) : assignDaysHeuristic;
  const result = await runPipeline(input, chatConstraints, assignFn, catalogue);
  if (aiEnabled) {
    report.assign = assignReport;
    report.calls.push(...assignReport.calls);
    if (assignReport.fullFallback) report.fallbacks.push("day assignment: heuristic (AI unavailable)");
    else if (assignReport.fallbackDays.length) report.fallbacks.push(`day assignment: heuristic for day(s) ${assignReport.fallbackDays.join(", ")}`);
  }

  report.narration = await narratePlan(result, catalogue, aiEnabled);
  if (report.narration.llm) report.calls.push(report.narration.llm);
  if (aiEnabled && !report.narration.llm) {
    report.fallbacks.push("narration: templates (AI unavailable)");
  } else if (aiEnabled && report.narration.source !== "ai") {
    report.fallbacks.push(`narration: ${report.narration.replaced.length} text(s) failed grounding and use templates`);
  }
  return { ...result, ai: report };
}
