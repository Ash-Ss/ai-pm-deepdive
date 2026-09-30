/**
 * Constraint helpers. The form is converted into constraints (source "form")
 * so every downstream stage reads one list, whether a preference came from the
 * form, the chat, or a default.
 */
import type { Constraint, ConstraintType, TravellerProfile, TripInput } from "../types";

export type ConstraintOf<T extends ConstraintType> = Extract<Constraint, { type: T }>;

export function ofType<T extends ConstraintType>(constraints: Constraint[], type: T): ConstraintOf<T>[] {
  return constraints.filter((c): c is ConstraintOf<T> => c.type === type);
}

/** Only trip-wide constraints shape trip-wide decisions (levers, mobility, pool). */
export const isTripScope = (c: Constraint) => c.scope === "trip";

export function travellerProfiles(constraints: Constraint[]): TravellerProfile[] {
  return [...new Set(ofType(constraints, "traveller_profile").map((c) => c.params.profile))];
}

export function interestTags(constraints: Constraint[]): { like: Map<string, Constraint>; dislike: Map<string, Constraint> } {
  const like = new Map<string, Constraint>();
  const dislike = new Map<string, Constraint>();
  for (const c of ofType(constraints, "interest_weight")) {
    (c.params.sentiment === "like" ? like : dislike).set(c.params.tag, c);
  }
  return { like, dislike };
}

/** Traveller mix → profile(s). Seniors and kids can both apply. */
export function profilesFromTravellers(t: TripInput["travellers"]): TravellerProfile[] {
  const out: TravellerProfile[] = [];
  if (t.seniors > 0) out.push("elderly");
  if (t.children > 0) out.push("family_kids");
  if (out.length === 0) {
    const n = t.adults;
    out.push(n === 1 ? "solo" : n === 2 ? "couple" : "friends");
  }
  return out;
}

export function paxCount(t: TripInput["travellers"]): number {
  return t.adults + t.children + t.seniors;
}

/**
 * Form fields → constraints. Presets that have a constraint equivalent become
 * that constraint (so mobility/profile filters see them); the rest
 * (late_riser, early_bird, …) only move levers and are passed to resolveLevers.
 */
export function constraintsFromInput(input: TripInput): Constraint[] {
  const out: Constraint[] = [];
  let n = 0;
  const base = { strength: "soft" as const, weightLevel: "medium" as const, scope: "trip", source: "form" as const, confidence: 1 };
  const push = (c: Omit<Constraint, "id" | "strength" | "weightLevel" | "scope" | "source" | "confidence"> & Partial<Constraint>) =>
    out.push({ ...base, id: `form-${++n}`, ...c } as Constraint);

  for (const p of input.presets) {
    if (p === "relaxed" || p === "balanced" || p === "packed") push({ type: "pace", params: { pace: p }, sourceText: `preset: ${p}` });
    if (p === "short_walks" || p === "step_free") push({ type: "mobility", params: { level: p }, strength: "hard", sourceText: `preset: ${p}` });
    if (p === "elderly" || p === "family_kids") push({ type: "traveller_profile", params: { profile: p }, sourceText: `preset: ${p}` });
    if (p === "foodie") push({ type: "interest_weight", params: { tag: "food", sentiment: "like" }, weightLevel: "high", sourceText: "preset: foodie" });
  }
  for (const profile of profilesFromTravellers(input.travellers)) {
    push({ type: "traveller_profile", params: { profile }, sourceText: `travellers: ${JSON.stringify(input.travellers)}` });
  }
  if (input.diet !== "any") push({ type: "dietary", params: { diet: input.diet }, strength: "hard" });
  if (input.budgetCapINR) push({ type: "budget_cap", params: { amountINR: input.budgetCapINR, per: "trip" }, strength: "hard" });
  for (const tag of input.interests) push({ type: "interest_weight", params: { tag, sentiment: "like" } });
  return dedupe(out);
}

/** Drop exact duplicates (same type + params + scope), keeping the first. */
export function dedupe(constraints: Constraint[]): Constraint[] {
  const seen = new Set<string>();
  return constraints.filter((c) => {
    const key = `${c.type}|${c.scope}|${JSON.stringify(c.params)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
