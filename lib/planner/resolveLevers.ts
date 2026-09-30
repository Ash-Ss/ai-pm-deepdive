/**
 * Stage 1 — resolve the scheduler's levers.
 *
 * default preset → presets implied by constraints (and form presets), merged
 * strictest-wins per lever → explicit constraint values on top (a user saying
 * "start at 8" beats the late_riser preset).
 */
import type { Constraint, LeverName, Levers, PresetName, PresetsFile, StageResult, TimeWindow } from "../types";
import { isTripScope } from "./constraints";
import { fromMin, toMin } from "./time";
import { startTrace } from "./trace";

export type LeverSource = { lever: LeverName; value: unknown; setBy: string; candidates?: string[] };
export type ResolvedLevers = { levers: Levers; provenance: LeverSource[]; appliedPresets: { preset: PresetName; reason: string }[] };

/** Which preset a constraint implies, if any. */
function presetFor(c: Constraint): PresetName | null {
  switch (c.type) {
    case "pace": return c.params.pace;
    case "mobility": return c.params.level === "full" ? null : c.params.level;
    case "traveller_profile": return c.params.profile === "elderly" || c.params.profile === "family_kids" ? c.params.profile : null;
    case "interest_weight": return c.params.tag === "food" && c.params.sentiment === "like" ? "foodie" : null;
    default: return null;
  }
}

/** Numeric view of a lever value so "max"/"min" work for times too (later = bigger). */
const num = (v: unknown) => (typeof v === "string" ? toMin(v) : (v as number));

function intersect(windows: TimeWindow[]): TimeWindow | null {
  const start = Math.max(...windows.map((w) => toMin(w.start)));
  const end = Math.min(...windows.map((w) => toMin(w.end)));
  return start < end ? { start: fromMin(start), end: fromMin(end) } : null;
}

export function resolveLevers(
  constraints: Constraint[],
  presets: PresetsFile,
  formPresets: PresetName[] = [],
): StageResult<ResolvedLevers> {
  const t = startTrace("resolveLevers", { constraints: constraints.length, formPresets });

  // 1. Which presets apply, and why.
  const applied: { preset: PresetName; reason: string }[] = [];
  const addPreset = (preset: PresetName, reason: string) => {
    if (preset === "default" || applied.some((a) => a.preset === preset)) return;
    applied.push({ preset, reason });
  };
  for (const p of formPresets) addPreset(p, "form");
  for (const c of constraints.filter(isTripScope)) {
    const p = presetFor(c);
    if (p) addPreset(p, `constraint ${c.id} (${c.type})`);
  }
  t.decide("presets applied", "form presets plus presets implied by trip-scope constraints", applied);

  // 2. Merge strictest-wins per lever.
  const levers = { ...presets.presets.default } as Levers;
  const provenance: LeverSource[] = [];
  const rules = presets.combine.rules;

  for (const lever of Object.keys(presets.presets.default) as LeverName[]) {
    const offers = applied
      .map((a) => ({ ...a, value: presets.presets[a.preset][lever] }))
      .filter((o) => o.value !== undefined);
    if (offers.length === 0) {
      provenance.push({ lever, value: levers[lever], setBy: "default" });
      continue;
    }
    const rule = rules[lever];
    const candidates = offers.map((o) => `${o.preset}=${JSON.stringify(o.value)}`);
    if (rule === "intersect") {
      const merged = intersect(offers.map((o) => o.value as TimeWindow));
      if (merged) {
        (levers as Record<string, unknown>)[lever] = merged;
        provenance.push({ lever, value: merged, setBy: `intersect(${offers.map((o) => o.preset).join(", ")})`, candidates });
      } else {
        provenance.push({ lever, value: levers[lever], setBy: "default (preset windows don't overlap)", candidates });
        t.decide(`kept default ${lever}`, "preset windows don't overlap", candidates);
      }
      continue;
    }
    const pick = offers.reduce((best, o) => {
      const better = rule === "max" ? num(o.value) > num(best.value) : num(o.value) < num(best.value);
      return better ? o : best;
    });
    (levers as Record<string, unknown>)[lever] = pick.value;
    provenance.push({ lever, value: pick.value, setBy: `preset ${pick.preset} (${pick.reason}, ${rule} wins)`, candidates });
  }

  // 3. Explicit values from constraints override presets.
  const setExplicit = (lever: LeverName, value: unknown, c: Constraint) => {
    (levers as Record<string, unknown>)[lever] = value;
    const row = provenance.find((p) => p.lever === lever)!;
    row.candidates = [...(row.candidates ?? []), `was ${JSON.stringify(row.value)} via ${row.setBy}`];
    row.value = value;
    row.setBy = `constraint ${c.id} (${c.type}, explicit)`;
  };
  for (const c of constraints.filter(isTripScope)) {
    if (c.type === "day_window") {
      if (c.params.start) setExplicit("dayStart", c.params.start, c);
      if (c.params.end) setExplicit("dayEnd", c.params.end, c);
    }
    if (c.type === "max_transit_per_day") setExplicit("maxTransitMinPerDay", c.params.minutes, c);
    if (c.type === "max_walk_km_per_day") setExplicit("maxWalkKmPerDay", c.params.km, c);
  }

  // Guard against an impossible window (e.g. late_riser + an explicit early end).
  if (toMin(levers.dayStart) >= toMin(levers.dayEnd)) {
    t.decide("reset day window to default", `dayStart ${levers.dayStart} ≥ dayEnd ${levers.dayEnd}`);
    levers.dayStart = presets.presets.default.dayStart;
    levers.dayEnd = presets.presets.default.dayEnd;
  }

  return t.finish({ levers, provenance, appliedPresets: applied }, { levers, provenance });
}
