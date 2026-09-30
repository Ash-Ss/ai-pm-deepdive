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
import { resolveMention } from "./resolvePlaces";

// ---------------------------------------------------------------------------
// Output contract
// ---------------------------------------------------------------------------

export const Intent = z.enum(["add_constraints", "edit_plan", "regenerate", "question", "out_of_scope"]);
export type Intent = z.infer<typeof Intent>;

export const MOBILITY_QUESTION: ClarifyingQuestion = {
  id: "mobility",
  kind: "mobility",
  text: "How much walking is comfortable for your parents?",
  options: ["Walks fine, just slower", "Short walks only", "Needs step-free access"],
};

export type ConstraintOp =
  | { op: "add"; constraint: Constraint }
  | { op: "update"; constraint: Constraint }
  | { op: "remove"; id: string };

export type ClarifyingQuestion = {
  /** "mobility", "place-<n>" or "ai-<n>"; the client sends it back with the chosen option. */
  id: string;
  kind: "mobility" | "place" | "freeform";
  text: string;
  options: string[];
  /** Place questions: what to create once the user picks one of the options. */
  pending?: { draft: DraftConstraint; candidates: { id: string; kind: "city" | "poi"; name: string }[] };
};

export type ExtractResult = {
  intent: Intent;
  ops: ConstraintOp[];
  /** First of clarifyingQuestions, for callers that show one at a time. */
  clarifyingQuestion?: ClarifyingQuestion;
  clarifyingQuestions: ClarifyingQuestion[];
  /** User-visible: things we couldn't act on (e.g. a place we don't cover). */
  warnings: string[];
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

export type ExtractContext = {
  summary: string;
  cityIds: string[];
  today: string;
  /** Cities in the current trip: listed first when a place mention is ambiguous. */
  tripCityIds?: string[];
};

// ---------------------------------------------------------------------------
// Draft → real constraints (shared by AI and rules)
// ---------------------------------------------------------------------------

type ResolveState = {
  catalogue: Catalogue;
  notes: string[];
  warnings: string[];
  questions: ClarifyingQuestion[];
  tripCityIds: string[];
};

export function resolveDraftOps(
  drafts: ExtractOutput["ops"],
  current: Constraint[],
  catalogue: Catalogue,
  tripCityIds: string[] = [],
): { ops: ConstraintOp[]; notes: string[]; warnings: string[]; questions: ClarifyingQuestion[]; mobilityUnknown: boolean } {
  const st: ResolveState = { catalogue, notes: [], warnings: [], questions: [], tripCityIds };
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
      else st.notes.push(`Ignored remove of unknown constraint "${d.targetId}"`);
      continue;
    }
    if (!d.constraint) {
      st.notes.push(`Ignored ${d.op} without a constraint`);
      continue;
    }
    if (d.op === "update" && !(d.targetId && current.some((c) => c.id === d.targetId))) {
      st.notes.push(`Update targeted unknown constraint "${d.targetId}"; treating it as new`);
    }
    const draft = d.constraint;
    if (draft.type === "mobility" && draft.params.level === "unknown") {
      mobilityUnknown = true;
      continue;
    }
    const resolved = resolveDraft(draft, st);
    if (!resolved) continue; // became a clarifying question
    const id = d.op === "update" && d.targetId && current.some((c) => c.id === d.targetId) ? d.targetId : newId();
    const op = finalise(resolved, id, draft, st, d.op === "update" && id === d.targetId, newId);
    ops.push(op);
  }
  return { ops, notes: st.notes, warnings: st.warnings, questions: st.questions, mobilityUnknown };
}

/** Validate strictly; anything that doesn't validate is kept as a visible freeform note, never dropped. */
function finalise(resolved: Omit<Constraint, "id" | "source">, id: string, draft: DraftConstraint, st: ResolveState, isUpdate: boolean, newId: () => string): ConstraintOp {
  const candidate = { ...resolved, id, source: "chat" as const };
  // Accessibility is never optional: a wheelchair means hard step-free.
  if (candidate.type === "mobility" && (candidate.params as { level?: string }).level === "step_free") candidate.strength = "hard";
  const parsed = Constraint.safeParse(candidate);
  if (!parsed.success) {
    st.notes.push(`Kept "${draft.sourceText}" as freeform (didn't validate: ${parsed.error.issues[0]?.message})`);
    return { op: "add", constraint: freeform(newId(), draft.sourceText, draft) };
  }
  return isUpdate ? { op: "update", constraint: parsed.data } : { op: "add", constraint: parsed.data };
}

function freeform(id: string, text: string, d: { strength: "hard" | "soft"; weightLevel: "low" | "medium" | "high"; sourceText: string; confidence: number }): Constraint {
  return { id, type: "freeform", params: { text }, strength: d.strength, weightLevel: d.weightLevel, scope: "trip", source: "chat", sourceText: d.sourceText, confidence: d.confidence };
}

const coveredCities = (c: Catalogue) => c.cities.map((x) => x.name).join(", ");

/**
 * Swap place text for catalogue IDs; convert city↔POI when the text resolves to the other kind.
 * Ambiguous → a clarifying question (returns null); unknown → a warning plus a freeform note.
 */
function resolveDraft(draft: DraftConstraint, st: ResolveState): Omit<Constraint, "id" | "source"> | null {
  const { catalogue } = st;
  const base = { strength: draft.strength, weightLevel: draft.weightLevel, scope: resolveScope(draft.scope, st), sourceText: draft.sourceText, confidence: draft.confidence };
  const unknown = (text: string, what: string) => {
    st.warnings.push(`I couldn't find "${text}" among the places this planner covers (${coveredCities(catalogue)} and their sights), so I noted it but can't plan for it.`);
    return { ...base, type: "freeform" as const, params: { text: `${what}: ${text}` } };
  };
  const ask = (text: string, options: { id: string; kind: "city" | "poi"; name: string }[]) => {
    // Places in this trip's cities first: "the fort" on a Sambhajinagar trip is probably Daulatabad.
    const inTrip = (o: { id: string; kind: string }) =>
      o.kind === "city" ? st.tripCityIds.includes(o.id) : st.tripCityIds.includes(catalogue.pois.find((p) => p.id === o.id)?.cityId ?? "");
    const sorted = [...options].sort((a, b) => Number(inTrip(b)) - Number(inTrip(a))).slice(0, 3);
    st.questions.push({
      id: `place-${st.questions.length + 1}`,
      kind: "place",
      text: `Which "${text}" did you mean?`,
      options: sorted.map((o) => o.name),
      pending: { draft, candidates: sorted },
    });
    st.notes.push(`"${text}" matches several places; asked which one`);
    return null;
  };
  const one = (text: string, prefer: "city" | "poi") => {
    const r = resolveMention(text, catalogue, prefer);
    if (r.status === "resolved") st.notes.push(`"${text}" → ${r.match.kind} ${r.match.id}`);
    return r;
  };

  switch (draft.type) {
    case "city_include":
    case "city_exclude":
    case "poi_include":
    case "poi_exclude": {
      const include = draft.type.endsWith("include");
      const r = one(draft.params.text, draft.type.startsWith("city") ? "city" : "poi");
      if (r.status === "none") return unknown(draft.params.text, include ? "wants to include" : "wants to skip");
      if (r.status === "ambiguous") return ask(draft.params.text, r.options);
      return placeConstraint(base, include, r.match);
    }
    case "city_order": {
      const ids: string[] = [];
      for (const t of draft.params.texts) {
        const r = one(t, "city");
        if (r.status === "resolved" && r.match.kind === "city") ids.push(r.match.id);
        else return unknown(draft.params.texts.join(" → "), "city order");
      }
      return { ...base, type: "city_order", params: { cityIds: ids } };
    }
    case "nights_in_city": {
      const r = one(draft.params.text, "city");
      if (r.status !== "resolved" || r.match.kind !== "city") return unknown(draft.params.text, "nights in");
      return { ...base, type: "nights_in_city", params: { cityId: r.match.id, min: draft.params.min, max: draft.params.max } };
    }
    case "date_anchor": {
      const r = draft.params.text ? one(draft.params.text, "poi") : null;
      if (r?.status === "none") st.warnings.push(`I couldn't find "${draft.params.text}"; I kept the date ${draft.params.date} only.`);
      if (r?.status === "ambiguous") return ask(draft.params.text!, r.options);
      const m = r?.status === "resolved" ? r.match : null;
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

function placeConstraint(base: Omit<Constraint, "id" | "source" | "type" | "params">, include: boolean, m: { kind: "city" | "poi"; id: string }): Omit<Constraint, "id" | "source"> {
  if (m.kind === "city") return { ...base, type: include ? "city_include" : "city_exclude", params: { cityId: m.id } } as Omit<Constraint, "id" | "source">;
  return { ...base, type: include ? "poi_include" : "poi_exclude", params: { poiId: m.id } } as Omit<Constraint, "id" | "source">;
}

function resolveScope(scope: string, st: ResolveState): string {
  if (ConstraintScope.safeParse(scope).success && (!scope.startsWith("city:") || st.catalogue.cities.some((c) => `city:${c.id}` === scope))) return scope;
  const r = scope.startsWith("city:") ? resolveMention(scope.replace(/^city:/, ""), st.catalogue, "city") : null;
  if (r?.status === "resolved" && r.match.kind === "city") return `city:${r.match.id}`;
  st.notes.push(`Unrecognised scope "${scope}"; using whole trip`);
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

function assemble(
  intent: Intent,
  r: ReturnType<typeof resolveDraftOps>,
  current: Constraint[],
  aiQuestion: { text: string; options: string[] } | undefined,
  source: "ai" | "rules",
): ExtractResult {
  const questions = [...r.questions];
  if (needsMobilityQuestion(current, r.ops, r.mobilityUnknown)) {
    questions.push(MOBILITY_QUESTION);
    r.notes.push("Asked the standard mobility question for elderly travellers");
  } else if (aiQuestion && aiQuestion.text !== MOBILITY_QUESTION.text) {
    questions.push({ id: "ai-1", kind: "freeform", text: aiQuestion.text, options: aiQuestion.options });
  }
  return { intent, ops: r.ops, clarifyingQuestion: questions[0], clarifyingQuestions: questions, warnings: r.warnings, notes: r.notes, source };
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
  const r = resolveDraftOps(data.ops, current, catalogue, context.tripCityIds);
  return { ...assemble(data.intent, r, current, data.clarifyingQuestion, "ai"), llm: meta };
}

type Rule = { re: RegExp; make: (m: RegExpMatchArray) => DraftConstraint | DraftConstraint[] };
const soft = (weightLevel: "low" | "medium" | "high" = "medium") => ({ strength: "soft" as const, weightLevel, scope: "trip", confidence: 0.7 });
const hard = { strength: "hard" as const, weightLevel: "high" as const, scope: "trip", confidence: 0.8 };
const PLACE = String.raw`(?:the\s+)?([A-Z][\w'’]*(?:\s+[A-Z][\w'’]*)*|[a-z]+\s+(?:fort|caves?|lake|temple|beach|market|museum))`;

/** The same vague-phrase table as the prompt, for when AI is off or unavailable. */
const RULES: Rule[] = [
  { re: /\b(late start|late mornings?|wake up late|sleep in|late riser)\b/i, make: (m) => ({ ...soft(), type: "day_window", params: { start: "10:30" }, sourceText: m[0] }) },
  { re: /\bnothing in the morning\b/i, make: (m) => ({ ...soft(), type: "day_window", params: { start: "11:00" }, sourceText: m[0] }) },
  { re: /\b(relaxed|take it easy|slow pace)\b/i, make: (m) => ({ ...soft(), type: "pace", params: { pace: "relaxed" }, sourceText: m[0] }) },
  { re: /\b(packed|see everything|as much as possible)\b/i, make: (m) => ({ ...soft(), type: "pace", params: { pace: "packed" }, sourceText: m[0] }) },
  { re: /\b(elderly|senior|old) (parents|mother|father|mom|dad|couple)\b|\bgrand(parents|ma|pa)\b/i, make: (m) => ({ ...soft(), type: "traveller_profile", params: { profile: "elderly" }, sourceText: m[0] }) },
  { re: /\b(short walks|bad knees?|can'?t walk (much|far))\b/i, make: (m) => ({ ...hard, type: "mobility", params: { level: "short_walks" }, sourceText: m[0] }) },
  { re: /\b(wheelchair|step[- ]free)\b/i, make: (m) => ({ ...hard, type: "mobility", params: { level: "step_free" }, sourceText: m[0] }) },
  { re: /\bjain\b/i, make: (m) => ({ ...hard, type: "dietary", params: { diet: "jain" }, sourceText: m[0] }) },
  { re: /\b(pure )?veg(etarian)?\b(?! options)/i, make: (m) => ({ ...hard, type: "dietary", params: { diet: "veg" }, sourceText: m[0] }) },
  { re: new RegExp(String.raw`\b(?:[Ss]kip|[Aa]void|[Nn]o|[Nn]ot interested in|[Ee]xclude|[Rr]emove|[Dd]rop)\s+${PLACE}`, "g"), make: (m) => ({ ...soft("high"), type: "poi_exclude", params: { text: m[1] }, sourceText: m[0] }) },
  { re: new RegExp(String.raw`\b(?:[Mm]ust see|[Mm]ust visit|[Ii]nclude|[Aa]dd|[Ww]ant to see|[Vv]isit)\s+${PLACE}`, "g"), make: (m) => ({ ...hard, type: "poi_include", params: { text: m[1] }, sourceText: m[0] }) },
];

export function extractConstraintsRules(message: string, current: Constraint[], catalogue: Catalogue, tripCityIds: string[] = []): ExtractResult {
  const drafts: ExtractOutput["ops"] = [];
  for (const rule of RULES) {
    const matches = rule.re.global ? [...message.matchAll(rule.re)] : ([message.match(rule.re)].filter(Boolean) as RegExpMatchArray[]);
    for (const m of matches) {
      const made = rule.make(m);
      for (const c of Array.isArray(made) ? made : [made]) drafts.push({ op: "add", constraint: c });
    }
  }
  const r = resolveDraftOps(drafts, current, catalogue, tripCityIds);
  const intent: Intent = r.ops.length || r.questions.length ? "add_constraints" : /\?\s*$/.test(message) ? "question" : "add_constraints";
  if (!r.ops.length && !r.questions.length) r.notes.push("No rule matched; with AI off, only common phrases are understood");
  return assemble(intent, r, current, undefined, "rules");
}

/** Turn the user's pick for a clarifying question into a constraint op (null = not answerable this way). */
export function answerQuestion(q: ClarifyingQuestion, option: string, current: Constraint[]): ConstraintOp | null {
  const id = nextChatId(current);
  if (q.kind === "mobility") {
    const level = option === MOBILITY_QUESTION.options[1] ? "short_walks" : option === MOBILITY_QUESTION.options[2] ? "step_free" : option === MOBILITY_QUESTION.options[0] ? "full" : null;
    if (!level) return null;
    return {
      op: "add",
      constraint: { id, type: "mobility", params: { level }, strength: level === "full" ? "soft" : "hard", weightLevel: "high", scope: "trip", source: "chat", sourceText: option, confidence: 1 },
    };
  }
  if (q.kind === "place" && q.pending) {
    const pick = q.pending.candidates.find((c) => c.name === option);
    if (!pick) return null;
    const d = q.pending.draft;
    const base = { strength: d.strength, weightLevel: d.weightLevel, scope: d.scope.startsWith("day:") || d.scope === "trip" ? d.scope : "trip", sourceText: `${d.sourceText} → ${option}`, confidence: 1 };
    const include = !d.type.endsWith("exclude");
    const made = d.type === "date_anchor"
      ? { ...base, type: "date_anchor" as const, params: { date: d.params.date, ...(pick.kind === "poi" ? { poiId: pick.id } : { cityId: pick.id }) } }
      : placeConstraint(base, include, pick);
    const parsed = Constraint.safeParse({ ...made, id, source: "chat" });
    return parsed.success ? { op: "add", constraint: parsed.data } : null;
  }
  return null; // freeform questions are answered as a normal chat message
}

/** Back-compat helper used by scripts: answer the mobility question by its option text. */
export const mobilityAnswerToOp = (answer: string, current: Constraint[]) => answerQuestion(MOBILITY_QUESTION, answer, current);

function nextChatId(current: Constraint[]): string {
  let n = current.filter((c) => c.id.startsWith("chat-")).length;
  let id: string;
  do id = `chat-${++n}`; while (current.some((c) => c.id === id));
  return id;
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
