/**
 * Tiny helper so every stage records its trace the same way:
 *   const t = startTrace("routeOrder", { cities });
 *   t.decide("picked mumbai → pune", "lowest score", { score });
 *   return t.finish(result, { best });
 */
import type { StageResult, Trace, TraceDecision } from "../types";

export function startTrace(stage: string, inputs: Record<string, unknown>) {
  const started = Date.now();
  const decisions: TraceDecision[] = [];
  return {
    decide(what: string, why: string, data?: unknown) {
      decisions.push(data === undefined ? { what, why } : { what, why, data });
    },
    finish<T>(result: T, outputs: Record<string, unknown>): StageResult<T> {
      const trace: Trace = { stage, inputs, decisions, outputs, durationMs: Date.now() - started };
      return { result, trace };
    },
  };
}
