/**
 * Chat message → typed constraint operations.
 *
 * The LLM sees a *draft* schema where places are free text (params.text), never
 * IDs; code then resolves places against the catalogue, assigns IDs, validates
 * every constraint with the strict zod schema, and applies safety rules
 * (wheelchair ⇒ hard step_free, elderly without mobility info ⇒ ask).
 *
 * extractConstraintsRules is the no-AI fallback: the same vague-phrase table,
 * as regexes, so the app still understands the common cases without Gemini.
 */
import { z } from "zod";
import type { Catalogue } from "../catalogue";
import { callLLM, type LLMMeta } from "../llm";
import { Constraint, ConstraintScope, IsoDate, Pace, TimeHHMM, TravellerProfile } from "../types";
import { resolvePlace } from "./resolvePlaces";

// ---------------------------------------------------------------------------
// Output contract
// ---------------------------------------------------------------------------

export const Intent = z.enum(["add_constraints", "edit_plan", "regenerate", "question", "out_of_scope"]);
export type Intent = z.infer<typeof Intent>;

export const MOBILITY_QUESTION = {
  text: "How much walking is comfortable for your parents?",
  options: ["Walks fine, just slower", "Short walks only", "Needs step-free access"],
};

export type ConstraintOp =
  | { op: "add"; constraint: Constraint }
  | { op: "update"; constraint: Constraint }
  | { op: "remove"; id: string };

export type ExtractResult = {
  intent: Intent;
  ops: ConstraintOp[];
  clarifyingQuestion?: { text: string; options: string[] };
  /** What code changed or couldn't resolve (shown in the behind-the-scenes view). */
  notes: string[];
  source: "ai" | "rules";
  llm?: LLMMeta;
};

// ---------------------------------------------------------------------------
// Draft schema the LLM fills in (places as text, mobility may be "unknown")
// ---------------------------------------------------------------------------

const draftBase = {
  strength: z.enum(["hard", "soft"]),
  weightLevel: z.enum(["low", "medium", "high"]),
  scope: z.string().describe('"trip", "city:<cityId>" or "day:<n>"'),
  sourceText: z.string().describe("the user's exact words that produced this"),
  confidence: z.number().min(0).max(1),
};
const d = <T extends string, P extends z.ZodType>(type: T, params: P) => z.object({ ...draftBase, type: z.literal(type), params });
const PlaceText = z.string().describe("the place exactly as the user wrote it; code resolves it");

export const DraftConstraint = z.discriminatedUnion("type", [
  d("day_window", z.object({ start: TimeHHMM.optional(), end: TimeHHMM.optional() })),
  d("pace", z.object({ pace: Pace })),
  d("mobility", z.object({ level: z.enum(["full", "short_walks", "step_free", "unknown"]) })),
  d("traveller_profile", z.object({ profile: TravellerProfile })),
  d("city_include", z.object({ text: PlaceText })),
  d("city_exclude", z.object({ text: PlaceText })),
  d("city_order", z.object({ texts: z.array(PlaceText).min(2) })),
  d("nights_in_city", z.object({ text: PlaceText, min: z.number().int().min(0).optional(), max: z.number().int().min(0).optional() })),
  d("date_anchor", z.object({ date: IsoDate, text: PlaceText.optional(), note: z.string().optional() })),
  d("poi_include", z.object({ text: PlaceText })),
  d("poi_exclude", z.object({ text: PlaceText })),
  d("max_transit_per_day", z.object({ minutes: z.number().int().positive() })),
  d("max_walk_km_per_day", z.object({ km: z.number().positive() })),
  d("budget_cap", z.object({ amountINR: z.number().positive(), per: z.enum(["trip", "day", "person_day"]) })),
  d("interest_weight", z.object({ tag: z.string(), sentiment: z.enum(["like", "dislike"]) })),
  d("dietary", z.object({ diet: z.enum(["veg", "jain", "non_veg", "any"]) })),
  d("avoid_tag", z.object({ tag: z.string() })),
  d("freeform", z.object({ text: z.string() })),
]);
export type DraftConstraint = z.infer<typeof DraftConstraint>;

export const ExtractOutput = z.object({
  intent: Intent,
  ops: z.array(z.object({
    op: z.enum(["add", "update", "remove"]),
    targetId: z.string().optional().describe("id of an existing constraint, for update/remove"),
    constraint: DraftConstraint.optional(),
  })),
  clarifyingQuestion: z.object({ text: z.string(), options: z.array(z.string()).min(2).max(4) }).optional(),
});
export type ExtractOutput = z.infer<typeof ExtractOutput>;

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export const EXTRACT_SYSTEM = `You turn a traveller's chat message into constraint operations for a Maharashtra trip planner.
Return JSON only, matching the schema.

INTENT: add_constraints (new preferences/requirements), edit_plan (change a specific day/item), regenerate (start over / re-plan),
question (asks something, no change), out_of_scope (not about this trip).

CONSTRAINT TYPES — use only these; anything else goes in type "freeform" with params.text:
day_window{start?,end? "HH:MM"} · pace{pace: relaxed|balanced|packed} · mobility{level: full|short_walks|step_free|unknown}
traveller_profile{profile: solo|couple|friends|family_kids|elderly} · city_include{text} · city_exclude{text} · city_order{texts[]}
nights_in_city{text,min?,max?} · date_anchor{date "YYYY-MM-DD", text?, note?} · poi_include{text} · poi_exclude{text}
max_transit_per_day{minutes} · max_walk_km_per_day{km} · budget_cap{amountINR, per: trip|day|person_day}
interest_weight{tag, sentiment: like|dislike} · dietary{diet: veg|jain|non_veg|any} · avoid_tag{tag} · freeform{text}

STRENGTH: hard = must / can't / medical / dietary / accessibility / fixed dates. soft = prefer / like / hate / love / ideally.
WEIGHT: low = "ideally", "if possible"; medium = "prefer", "like"; high = "hate", "love", "really".

VAGUE PHRASES — map exactly:
- "late start", "wake up late" → day_window start "10:30"
- "nothing in the morning" → day_window start "11:00"
- "relaxed" → pace relaxed; "packed", "see everything" → pace packed
- "elderly parents" → traveller_profile elderly AND mobility level "unknown" (unless the message says how they walk)
- "short walks", "bad knees" → mobility short_walks (hard)
- "wheelchair" → mobility step_free (hard)
If mobility is unknown for elderly travellers, return ONE clarifyingQuestion with exactly these options:
"Walks fine, just slower" | "Short walks only" | "Needs step-free access".

PLACES: never invent or translate place names. Copy the user's words into params.text (or params.texts); code resolves them.
A single named sight (e.g. "Ajanta") is poi_include/poi_exclude; a city is city_include/city_exclude.
SCOPE: "trip" unless the user ties it to a city ("city:<cityId>" using the city ids given) or a day ("day:<n>").
UPDATE/REMOVE: when the message changes or cancels an existing constraint, use its id as targetId.
sourceText = the user's exact words for that constraint. confidence = how sure you are (0–1).`;

function buildPrompt(message: string, current: Constraint[], context: ExtractContext): string {
  const list = current.length
    ? current.map((c) => `- ${c.id}: ${c.type} ${JSON.stringify(c.params)} (${c.strength}, ${c.weightLevel}, ${c.scope}, from ${c.source})`).join("\n")
    : "(none)";
  return [
    `TRIP CONTEXT: ${context.summary}`,
    `CITY IDS: ${context.cityIds.join(", ")}`,
    `TODAY: ${context.today}`,
    `CURRENT CONSTRAINTS:\n${list}`,
    `USER MESSAGE:\n"""${message}"""`,
  ].join("\n\n");
}

export type ExtractContext = { summary: string; cityIds: string[]; today: string };

// ---------------------------------------------------------------------------
// Draft → real constraints (shared by AI and rules)
// ---------------------------------------------------------------------------

export function resolveDraftOps(
  drafts: ExtractOutput["ops"],
  current: Constraint[],
  catalogue: Catalogue,
): { ops: ConstraintOp[]; notes: string[]; mobilityUnknown: boolean } {
  const notes: string[] = [];
  const ops: ConstraintOp[] = [];
  let mobilityUnknown = false;
  const existingIds = new Set(current.map((c) => c.id));
  let n = current.filter((c) => c.id.startsWith("chat-")).length;
  const newId = () => {
    let id: string;
    do id = `chat-${++n}`; while (existingIds.has(id));
    existingIds.add(id);
    return id;
  };

  for (const d of drafts) {
    if (d.op === "remove") {
      if (d.targetId && current.some((c) => c.id === d.targetId)) ops.push({ op: "remove", id: d.targetId });
      else notes.push(`Ignored remove of unknown constraint "${d.targetId}"`);
      continue;
    }
    if (!d.constraint) {
      notes.push(`Ignored ${d.op} without a constraint`);
      continue;
    }
    if (d.op === "update" && !(d.targetId && current.some((c) => c.id === d.targetId))) {
      notes.push(`Update targeted unknown constraint "${d.targetId}"; treating it as new`);
    }
    const draft = d.constraint;
    if (draft.type === "mobility" && draft.params.level === "unknown") {
      mobilityUnknown = true;
      continue;
    }
    const resolved = resolveDraft(draft, catalogue, notes);
    if (!resolved) continue;
    const id = d.op === "update" && d.targetId && current.some((c) => c.id === d.targetId) ? d.targetId : newId();
    const candidate = { ...resolved, id, source: "chat" as const };
    // Accessibility is never optional: a wheelchair means hard step-free.
    if (candidate.type === "mobility" && candidate.params && (candidate.params as { level?: string }).level === "step_free") candidate.strength = "hard";
    const parsed = Constraint.safeParse(candidate);
    if (!parsed.success) {
      notes.push(`Kept "${draft.sourceText}" as freeform (didn't validate: ${parsed.error.issues[0]?.message})`);
      ops.push({ op: "add", constraint: freeform(newId(), draft.sourceText, draft) });
      continue;
    }
    ops.push(d.op === "update" && id === d.targetId ? { op: "update", constraint: parsed.data } : { op: "add", constraint: parsed.data });
  }
  return { ops, notes, mobilityUnknown };
}

function freeform(id: string, text: string, d: { strength: "hard" | "soft"; weightLevel: "low" | "medium" | "high"; sourceText: string; confidence: number }): Constraint {
  return { id, type: "freeform", params: { text }, strength: d.strength, weightLevel: d.weightLevel, scope: "trip", source: "chat", sourceText: d.sourceText, confidence: d.confidence };
}

/** Swap place text for catalogue IDs; convert city↔POI when the text resolves to the other kind. */
function resolveDraft(draft: DraftConstraint, catalogue: Catalogue, notes: string[]): Omit<Constraint, "id" | "source"> | null {
  const base = { strength: draft.strength, weightLevel: draft.weightLevel, scope: resolveScope(draft.scope, catalogue, notes), sourceText: draft.sourceText, confidence: draft.confidence };
  const unresolved = (text: string, what: string) => {
    notes.push(`Couldn't find "${text}" in the catalogue (${what}); kept as a note`);
    return { ...base, type: "freeform" as const, params: { text: `${what}: ${text}` } };
  };
  switch (draft.type) {
    case "city_include":
    case "city_exclude":
    case "poi_include":
    case "poi_exclude": {
      const include = draft.type.endsWith("include");
      const m = resolvePlace(draft.params.text, catalogue, draft.type.startsWith("city") ? "city" : "poi");
      if (!m) return unresolved(draft.params.text, include ? "wants to include" : "wants to skip");
      notes.push(`"${draft.params.text}" → ${m.kind} ${m.id}`);
      if (m.kind === "city") return { ...base, type: include ? "city_include" : "city_exclude", params: { cityId: m.id } };
      return { ...base, type: include ? "poi_include" : "poi_exclude", params: { poiId: m.id } };
    }
    case "city_order": {
      const ids = draft.params.texts.map((t) => resolvePlace(t, catalogue, "city")).filter((m) => m?.kind === "city").map((m) => m!.id);
      if (ids.length < 2) return unresolved(draft.params.texts.join(" → "), "city order");
      return { ...base, type: "city_order", params: { cityIds: ids } };
    }
    case "nights_in_city": {
      const m = resolvePlace(draft.params.text, catalogue, "city");
      if (m?.kind !== "city") return unresolved(draft.params.text, "nights in");
      return { ...base, type: "nights_in_city", params: { cityId: m.id, min: draft.params.min, max: draft.params.max } };
    }
    case "date_anchor": {
      const m = draft.params.text ? resolvePlace(draft.params.text, catalogue) : null;
      if (draft.params.text && !m) notes.push(`Date anchor place "${draft.params.text}" not found; keeping the date only`);
      return {
        ...base, type: "date_anchor",
        params: { date: draft.params.date, ...(m?.kind === "city" ? { cityId: m.id } : {}), ...(m?.kind === "poi" ? { poiId: m.id } : {}), note: draft.params.note ?? draft.params.text },
      };
    }
    case "mobility":
      return { ...base, type: "mobility", params: { level: draft.params.level as "full" | "short_walks" | "step_free" } };
    default:
      return { ...base, type: draft.type, params: draft.params } as Omit<Constraint, "id" | "source">;
  }
}

function resolveScope(scope: string, catalogue: Catalogue, notes: string[]): string {
  if (ConstraintScope.safeParse(scope).success && (!scope.startsWith("city:") || catalogue.cities.some((c) => `city:${c.id}` === scope))) return scope;
  const cityText = scope.replace(/^city:/, "");
  const m = scope.startsWith("city:") ? resolvePlace(cityText, catalogue, "city") : null;
  if (m?.kind === "city") return `city:${m.id}`;
  notes.push(`Unrecognised scope "${scope}"; using whole trip`);
  return "trip";
}

/** Elderly travellers but nothing said about walking → ask, with the fixed options. */
function needsMobilityQuestion(current: Constraint[], ops: ConstraintOp[], mobilityUnknown: boolean): boolean {
  const all = [...current, ...ops.flatMap((o) => (o.op === "remove" ? [] : [o.constraint]))];
  const elderly = all.some((c) => c.type === "traveller_profile" && c.params.profile === "elderly");
  const hasMobility = all.some((c) => c.type === "mobility");
  const addedElderly = ops.some((o) => o.op !== "remove" && o.constraint.type === "traveller_profile" && o.constraint.params.profile === "elderly");
  return !hasMobility && elderly && (mobilityUnknown || addedElderly);
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export async function extractConstraintsAI(message: string, current: Constraint[], context: ExtractContext, catalogue: Catalogue): Promise<ExtractResult> {
  const { data, meta } = await callLLM({
    name: "extractConstraints",
    system: EXTRACT_SYSTEM,
    prompt: buildPrompt(message, current, context),
    schema: ExtractOutput,
    temperature: 0.1,
  });
  const { ops, notes, mobilityUnknown } = resolveDraftOps(data.ops, current, catalogue);
  let clarifyingQuestion = data.clarifyingQuestion;
  if (needsMobilityQuestion(current, ops, mobilityUnknown)) {
    if (clarifyingQuestion?.text !== MOBILITY_QUESTION.text) notes.push("Asked the standard mobility question for elderly travellers");
    clarifyingQuestion = MOBILITY_QUESTION;
  }
  return { intent: data.intent, ops, clarifyingQuestion, notes, source: "ai", llm: meta };
}

type Rule = { re: RegExp; make: (m: RegExpMatchArray) => DraftConstraint | DraftConstraint[] };
const soft = (weightLevel: "low" | "medium" | "high" = "medium") => ({ strength: "soft" as const, weightLevel, scope: "trip", confidence: 0.7 });
const hard = { strength: "hard" as const, weightLevel: "high" as const, scope: "trip", confidence: 0.8 };

/** The same vague-phrase table as the prompt, for when AI is off or unavailable. */
const RULES: Rule[] = [
  { re: /\b(late start|wake up late|sleep in|late riser)\b/i, make: (m) => ({ ...soft(), type: "day_window", params: { start: "10:30" }, sourceText: m[0] }) },
  { re: /\bnothing in the morning\b/i, make: (m) => ({ ...soft(), type: "day_window", params: { start: "11:00" }, sourceText: m[0] }) },
  { re: /\b(relaxed|take it easy|slow pace)\b/i, make: (m) => ({ ...soft(), type: "pace", params: { pace: "relaxed" }, sourceText: m[0] }) },
  { re: /\b(packed|see everything|as much as possible)\b/i, make: (m) => ({ ...soft(), type: "pace", params: { pace: "packed" }, sourceText: m[0] }) },
  { re: /\b(elderly|senior|old) (parents|mother|father|mom|dad|couple)\b|\bgrand(parents|ma|pa)\b/i, make: (m) => ({ ...soft(), type: "traveller_profile", params: { profile: "elderly" }, sourceText: m[0] }) },
  { re: /\b(short walks|bad knees?|can'?t walk (much|far))\b/i, make: (m) => ({ ...hard, type: "mobility", params: { level: "short_walks" }, sourceText: m[0] }) },
  { re: /\b(wheelchair|step[- ]free)\b/i, make: (m) => ({ ...hard, type: "mobility", params: { level: "step_free" }, sourceText: m[0] }) },
  { re: /\bjain\b/i, make: (m) => ({ ...hard, type: "dietary", params: { diet: "jain" }, sourceText: m[0] }) },
  { re: /\b(pure )?veg(etarian)?\b(?! options)/i, make: (m) => ({ ...hard, type: "dietary", params: { diet: "veg" }, sourceText: m[0] }) },
  { re: /\b([Ss]kip|[Aa]void|[Nn]o|[Nn]ot interested in|[Ee]xclude)\s+(?:the\s+)?([A-Z][\w'’]*(?:\s+[A-Z][\w'’]*)*)/g, make: (m) => ({ ...soft("high"), type: "poi_exclude", params: { text: m[2] }, sourceText: m[0] }) },
  { re: /\b([Mm]ust see|[Mm]ust visit|[Ii]nclude|[Aa]dd|[Ww]ant to see|[Vv]isit)\s+(?:the\s+)?([A-Z][\w'’]*(?:\s+[A-Z][\w'’]*)*)/g, make: (m) => ({ ...hard, type: "poi_include", params: { text: m[2] }, sourceText: m[0] }) },
];

export function extractConstraintsRules(message: string, current: Constraint[], catalogue: Catalogue): ExtractResult {
  const drafts: ExtractOutput["ops"] = [];
  for (const rule of RULES) {
    const matches = rule.re.global ? [...message.matchAll(rule.re)] : [message.match(rule.re)].filter(Boolean) as RegExpMatchArray[];
    for (const m of matches) {
      const made = rule.make(m);
      for (const c of Array.isArray(made) ? made : [made]) drafts.push({ op: "add", constraint: c });
    }
  }
  const { ops, notes, mobilityUnknown } = resolveDraftOps(drafts, current, catalogue);
  const clarifyingQuestion = needsMobilityQuestion(current, ops, mobilityUnknown) ? MOBILITY_QUESTION : undefined;
  const intent: Intent = ops.length ? "add_constraints" : /\?\s*$/.test(message) ? "question" : "add_constraints";
  if (!ops.length) notes.push("No rule matched; with AI off, only common phrases are understood");
  return { intent, ops, clarifyingQuestion, notes, source: "rules" };
}

/** Map an answer to MOBILITY_QUESTION to a constraint op. */
export function mobilityAnswerToOp(answer: string, current: Constraint[]): ConstraintOp | null {
  const level = answer === MOBILITY_QUESTION.options[1] ? "short_walks" : answer === MOBILITY_QUESTION.options[2] ? "step_free" : answer === MOBILITY_QUESTION.options[0] ? "full" : null;
  if (!level) return null;
  const id = `chat-${current.filter((c) => c.id.startsWith("chat-")).length + 1}`;
  return {
    op: "add",
    constraint: {
      id, type: "mobility", params: { level }, strength: level === "full" ? "soft" : "hard", weightLevel: "high",
      scope: "trip", source: "chat", sourceText: answer, confidence: 1,
    },
  };
}

export function applyOps(current: Constraint[], ops: ConstraintOp[]): Constraint[] {
  let out = [...current];
  for (const o of ops) {
    if (o.op === "remove") out = out.filter((c) => c.id !== o.id);
    else if (o.op === "update") out = out.map((c) => (c.id === o.constraint.id ? o.constraint : c));
    else out.push(o.constraint);
  }
  return out;
}
