/**
 * Server-side operations behind the API routes. Every function takes plain
 * JSON (trip input, constraints, a plan) and returns plain JSON, so route
 * handlers stay thin and the client never needs catalogue or planner code.
 *
 * Edit scopes (what gets re-run):
 *   full  — route, nights and everything after (city / nights / date changes)
 *   days  — keep route + nights, re-pick and re-schedule all days (pace, mobility, interests…)
 *   day:N — only the named day(s); every other day is left exactly as it was
 */
import { type Catalogue, loadCatalogue } from "../catalogue";
import { makeAIAssign } from "../ai/assignDays";
import {
  answerQuestion, applyOps, type ClarifyingQuestion, type ConstraintOp, type ExtractResult,
} from "../ai/extractConstraints";
import { type AIRunReport, extractFromChat, planTrip } from "../ai/index";
import { templateNarrateDay } from "../ai/narrate";
import { isAIEnabled } from "../llm";
import { type AssignedDay, type AssignInput, assignDaysHeuristic, isLightItem, sanitizeAssignment } from "../planner/assignDays";
import {
  applyLocked, dayTripWarnings, earlyStartChips, type OnStage, type PipelineResult, preparePlan, type PreparedPlan,
  scheduleSingleDay, toDay,
} from "../planner/pipeline";
import type { ScheduledDay } from "../planner/plannerTypes";
import { validatePlan, type ValidationReport } from "../planner/validatePlan";
import type { Constraint, ConstraintType, Day, Plan, TripInput } from "../types";

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export type PlaceInfo = {
  kind: "poi" | "rest" | "exp" | "hotel";
  name: string;
  lat: number;
  lng: number;
  category?: string;
  tier?: string;
  description?: string;
  priceINR?: number;
  accessibility?: { stairsLevel: string; terrain: string; walkingRequiredM: number; seating: boolean };
  /** Data confidence (0–1); the UI marks < 0.8 as "estimated". */
  confidence: number;
  needsVerification?: boolean;
  dietary?: { veg: boolean; jain: boolean; nonVeg: boolean };
};

export type PlanMeta = {
  cities: Record<string, string>;
  /** Display names for every city/POI id the plan or its constraints mention (chips need them). */
  names: Record<string, string>;
  route: { order: string[]; hops: { from: string; to: string; mode: string; minutes: number }[] };
  places: Record<string, PlaceInfo>;
};

export type AIInfo = { enabled: boolean; calls: { name: string; ms: number; cached: boolean; tokens: number; demo?: boolean }[]; fallbacks: string[] };

export type PlanResponse = {
  plan: Plan;
  /** Same as plan.traces; top-level for the "behind the scenes" view. */
  traces: Plan["traces"];
  /** "append": a day edit whose traces add to the plan's existing ones (clients send plans without traces). */
  tracesMode?: "replace" | "append";
  validation: ValidationReport;
  warnings: string[];
  /** Non-form constraints the client should keep (chat + planner chips). */
  chatConstraints: Constraint[];
  clarifyingQuestions: ClarifyingQuestion[];
  meta: PlanMeta;
  ai: AIInfo;
};

export type ChatResponse = {
  intent: ExtractResult["intent"];
  constraintOps: ConstraintOp[];
  clarifyingQuestion?: ClarifyingQuestion;
  clarifyingQuestions: ClarifyingQuestion[];
  updated?: PlanResponse;
  changedScope: "none" | "full" | "days" | `day:${string}`;
  explanation: string;
};

export type ServiceStage = "understanding" | Parameters<OnStage>[0] | "writing";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Constraints the user owns (chat). Form constraints are rebuilt from the trip input, and planner
 * chips (source "default", e.g. early starts) are recomputed on every plan — feeding them back
 * would freeze a day's start and remove the flexibility that produced them.
 */
const userConstraints = (plan: Plan) => plan.constraints.filter((c) => c.source === "chat");
const planning = (cs: Constraint[]) => cs.filter((c) => c.source === "chat");
const legsOf = (plan: Plan) => plan.legs.map((l) => ({ cityId: l.cityId, nights: l.nights }));
const allDays = (plan: Plan) => plan.legs.flatMap((l) => l.days);
const activityIds = (day: Day) => day.items.filter((i) => i.type === "activity" && i.refId).map((i) => i.refId!);
const lockedByDay = (plan: Plan): Record<number, string[]> =>
  Object.fromEntries(allDays(plan).map((d) => [d.dayNumber, d.items.filter((i) => i.locked && i.refId && i.type === "activity").map((i) => i.refId!)]).filter(([, ids]) => (ids as string[]).length));
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

function buildMeta(plan: Plan, catalogue: Catalogue, route: PipelineResult["debug"]["route"] | PreparedPlan["route"]): PlanMeta {
  const places: Record<string, PlaceInfo> = {};
  for (const leg of plan.legs) {
    const area = catalogue.cities.find((c) => c.id === leg.cityId)?.areas.find((a) => a.id === leg.baseAreaId);
    if (area) places[area.id] = { kind: "hotel", name: `Hotel area: ${area.name}`, lat: area.lat, lng: area.lng, confidence: 0.6 };
    for (const day of leg.days) {
      for (const i of day.items) {
        if (!i.refId || places[i.refId]) continue;
        const poi = catalogue.pois.find((p) => p.id === i.refId);
        if (poi) {
          places[poi.id] = {
            kind: "poi", name: poi.name, lat: poi.lat, lng: poi.lng, category: poi.category, tier: poi.tier, description: poi.shortDescription,
            priceINR: poi.priceINR, accessibility: poi.accessibility, confidence: poi.provenance.confidence, needsVerification: poi.needsVerification,
          };
          continue;
        }
        const r = catalogue.restaurants.find((x) => x.id === i.refId);
        if (r) { places[r.id] = { kind: "rest", name: r.name, lat: r.lat, lng: r.lng, confidence: r.provenance.confidence, dietary: r.dietary, category: r.cuisine.join(", ") }; continue; }
        const x = catalogue.experiences.find((e) => e.id === i.refId);
        if (x) {
          const linked = catalogue.pois.find((p) => x.linkedPoiIds.includes(p.id));
          places[x.id] = { kind: "exp", name: x.name, lat: linked?.lat ?? 0, lng: linked?.lng ?? 0, priceINR: x.priceINR, accessibility: x.accessibility, confidence: x.provenance.confidence };
        }
      }
    }
  }
  const names: Record<string, string> = Object.fromEntries(catalogue.cities.map((c) => [c.id, c.name]));
  for (const c of plan.constraints) {
    const p = c.params as { poiId?: string; cityId?: string };
    if (p.poiId) names[p.poiId] = catalogue.pois.find((x) => x.id === p.poiId)?.name ?? p.poiId;
  }
  for (const [id, info] of Object.entries(places)) names[id] ??= info.name;
  return {
    names,
    cities: Object.fromEntries(catalogue.cities.map((c) => [c.id, c.name])),
    route: { order: route.best.order, hops: route.best.hops.map((h) => ({ from: h.from, to: h.to, mode: h.edge.mode, minutes: h.minutes })) },
    places,
  };
}

function aiInfo(report?: AIRunReport, extra: AIInfo["calls"] = []): AIInfo {
  return {
    enabled: isAIEnabled(),
    calls: [...extra, ...(report?.calls ?? []).map((c) => ({ name: c.name, ms: c.ms, cached: c.cached, tokens: c.usage.totalTokens, demo: c.demo }))],
    fallbacks: [
      ...(report?.fallbacks ?? []),
      ...([...extra, ...(report?.calls ?? [])].some((c) => "demo" in c && c.demo) ? ["Gemini unavailable: served recorded demo answers"] : []),
    ],
  };
}

function toResponse(r: PipelineResult & { ai: AIRunReport }, catalogue: Catalogue, questions: ClarifyingQuestion[] = [], extraCalls: AIInfo["calls"] = []): PlanResponse {
  return {
    plan: r.plan,
    traces: r.plan.traces,
    validation: r.validation,
    warnings: r.plan.warnings,
    chatConstraints: userConstraints(r.plan),
    clarifyingQuestions: questions,
    meta: buildMeta(r.plan, catalogue, r.debug.route),
    ai: aiInfo(r.ai, extraCalls),
  };
}

// ---------------------------------------------------------------------------
// Full plan
// ---------------------------------------------------------------------------

export async function createPlan(
  input: TripInput,
  constraints: Constraint[],
  opts: { onStage?: (s: ServiceStage) => void; catalogue?: Catalogue } = {},
): Promise<PlanResponse> {
  const catalogue = opts.catalogue ?? loadCatalogue();
  opts.onStage?.("understanding");
  let chat = planning(constraints);
  let questions: ClarifyingQuestion[] = [];
  const extraCalls: AIInfo["calls"] = [];
  // The form's "Anything else?" box goes through the same extractor as chat messages.
  if (input.chatText.trim()) {
    const ex = await extractFromChat(input.chatText, chat, extractContext(input, catalogue), catalogue);
    chat = applyOps(chat, ex.ops);
    questions = ex.clarifyingQuestions;
    if (ex.llm) extraCalls.push({ name: ex.llm.name, ms: ex.llm.ms, cached: ex.llm.cached, tokens: ex.llm.usage.totalTokens, demo: ex.llm.demo });
  }
  const r = await planTrip({ ...input, chatText: "" }, chat, { catalogue, onStage: opts.onStage, onWriting: () => opts.onStage?.("writing") });
  return toResponse(r, catalogue, questions, extraCalls);
}

function extractContext(input: TripInput, catalogue: Catalogue) {
  return {
    summary: `${input.days} days from ${input.startDate}, places: ${input.cityIds.join(", ")}, travellers ${JSON.stringify(input.travellers)}, ${input.budgetTier} budget`,
    cityIds: catalogue.cities.map((c) => c.id),
    today: new Date().toISOString().slice(0, 10),
    tripCityIds: input.cityIds,
  };
}

// ---------------------------------------------------------------------------
// Single-day edits (other days untouched)
// ---------------------------------------------------------------------------

/** Replace one day of `plan` with a freshly scheduled version; returns the new plan + validation. */
function spliceDay(plan: Plan, prep: PreparedPlan, assigned: AssignedDay, catalogue: Catalogue): { plan: Plan; validation: ValidationReport; scheduled: ScheduledDay } {
  // (traces of this edit are attached below; the plan's earlier traces stay with the client)
  const next = clone(plan);
  const n = assigned.dayNumber;
  const old = allDays(plan).find((d) => d.dayNumber === n)!;
  const { day: scheduled, warnings, trace } = scheduleSingleDay(prep, plan, n, assigned);
  const locked = new Set(old.items.filter((i) => i.locked).map((i) => i.refId));
  for (const i of scheduled.items) if (i.refId && locked.has(i.refId) && i.type === "activity") i.locked = true;
  const day = toDay(scheduled, assigned.theme ?? (sameActivities(old, scheduled) ? old.title : undefined));
  templateNarrateDay(day, catalogue);
  for (const leg of next.legs) leg.days = leg.days.map((d) => (d.dayNumber === n ? day : d));

  // Chips and warnings for this day are recomputed; everything else is kept.
  next.constraints = [...next.constraints.filter((c) => c.id !== `auto-early-start-day-${n}`), ...earlyStartChips([scheduled])];
  next.warnings = [
    ...next.warnings.filter((w) => !w.startsWith(`Day ${n}:`)),
    ...warnings,
    ...dayTripWarnings(prep, [scheduled]).filter((w) => w.startsWith(`Day ${n}:`)),
  ];
  next.traces = [{ ...trace, stage: `edit:day-${n}:${trace.stage}` }];
  return { plan: next, validation: validateWhole(next, prep, scheduled), scheduled };
}

const sameActivities = (old: Day, d: ScheduledDay) =>
  activityIds(old).join() === d.items.filter((i) => i.type === "activity").map((i) => i.refId).join();

/** Validate the whole plan: the edited day as scheduled, the others as they stand. */
function validateWhole(plan: Plan, prep: PreparedPlan, edited: ScheduledDay): ValidationReport {
  const frames = prep.assignInput.legs.flatMap((l) => l.frames);
  const days: ScheduledDay[] = allDays(plan).map((d) => {
    if (d.dayNumber === edited.frame.dayNumber) return edited;
    const frame = frames.find((f) => f.dayNumber === d.dayNumber)!;
    // Untouched days were validated when planned; departure-buffer info isn't kept, so it isn't re-checked here.
    return { frame, items: d.items, dropped: [], penalties: {}, totals: d.totals, dayTripTransitAllowanceMin: Infinity, startOverride: null, departure: null };
  });
  return validatePlan(days, { levers: prep.resolved.levers, constraints: prep.constraints, pools: prep.pools, ctx: prep.ctx, cities: prep.catalogue.cities }).result;
}

function prepareFor(plan: Plan, constraints: Constraint[], catalogue: Catalogue): PreparedPlan {
  return preparePlan(plan.input, constraints, catalogue, { fixedLegs: legsOf(plan) });
}

function dayResponse(plan: Plan, validation: ValidationReport, prep: PreparedPlan, catalogue: Catalogue, chatConstraints: Constraint[]): PlanResponse {
  plan.constraints = [...prep.constraints.filter((c) => c.source === "form"), ...chatConstraints.filter((c) => !c.id.startsWith("auto-early-start")), ...plan.constraints.filter((c) => c.id.startsWith("auto-early-start"))];
  return {
    plan, traces: plan.traces, tracesMode: "append", validation, warnings: plan.warnings, chatConstraints: userConstraints(plan), clarifyingQuestions: [],
    meta: buildMeta(plan, catalogue, prep.route), ai: aiInfo(),
  };
}

export async function swapItem(plan: Plan, itemId: string, catalogue: Catalogue = loadCatalogue()): Promise<PlanResponse & { explanation: string }> {
  const day = allDays(plan).find((d) => d.items.some((i) => i.id === itemId));
  const item = day?.items.find((i) => i.id === itemId);
  if (!day || !item || item.type !== "activity" || !item.refId) throw new Error("Only a sightseeing item can be swapped");
  const chat = userConstraints(plan);
  const prep = prepareFor(plan, chat, catalogue);
  const leg = prep.assignInput.legs.find((l) => l.frames.some((f) => f.dayNumber === day.dayNumber))!;
  const frame = leg.frames.find((f) => f.dayNumber === day.dayNumber)!;
  const used = new Set(allDays(plan).flatMap(activityIds));
  const current = leg.pool.pois.find((p) => p.id === item.refId);

  // Next best: same area first, then same category, then pool score — no LLM involved.
  const candidates = leg.pool.pois
    .filter((p) => !used.has(p.id) && !frame.closedPoiIds.includes(p.id) && (!frame.lightOnly || isLightItem(p, leg.hotel.area)))
    .sort((a, b) =>
      Number(b.poi.areaId === current?.poi.areaId) - Number(a.poi.areaId === current?.poi.areaId) ||
      Number(b.poi.category === current?.poi.category) - Number(a.poi.category === current?.poi.category) ||
      b.score - a.score);

  for (const c of candidates.slice(0, 6)) {
    const ids = activityIds(day).map((id) => (id === item.refId ? c.id : id));
    const reasons = { [c.id]: [`swapped in for ${item.title.split(" — ")[0]}`, ...(c.poi.areaId === current?.poi.areaId ? [`same area (${c.poi.areaId})`] : []), `${c.poi.tier.replace("_", "-")}`] };
    const res = spliceDay(plan, prep, { dayNumber: day.dayNumber, itemIds: ids, reasons, source: "planner" }, catalogue);
    if (res.scheduled.items.some((i) => i.refId === c.id)) {
      return { ...dayResponse(res.plan, res.validation, prep, catalogue, chat), explanation: `Swapped ${item.title.split(" — ")[0]} for ${c.poi.name} on day ${day.dayNumber}.` };
    }
  }
  throw new Error("No alternative fits this day (opening hours, closures or time)");
}

export async function removeItem(plan: Plan, itemId: string, catalogue: Catalogue = loadCatalogue()): Promise<PlanResponse & { explanation: string; constraintOps: ConstraintOp[] }> {
  const day = allDays(plan).find((d) => d.items.some((i) => i.id === itemId));
  const item = day?.items.find((i) => i.id === itemId);
  if (!day || !item || item.type !== "activity" || !item.refId) throw new Error("Only a sightseeing item can be removed");
  // Remembered as a soft exclusion so later re-plans don't bring it back.
  const exclude: Constraint = {
    id: `chat-remove-${item.refId}`, type: "poi_exclude", params: { poiId: item.refId }, strength: "soft", weightLevel: "high",
    scope: "trip", source: "chat", sourceText: `removed ${item.title.split(" — ")[0]}`, confidence: 1,
  };
  const chat = [...userConstraints(plan).filter((c) => c.id !== exclude.id), exclude];
  const prep = prepareFor(plan, chat, catalogue);
  const ids = activityIds(day).filter((id) => id !== item.refId);
  const res = spliceDay(plan, prep, { dayNumber: day.dayNumber, itemIds: ids, source: "planner" }, catalogue);
  return {
    ...dayResponse(res.plan, res.validation, prep, catalogue, chat),
    explanation: `Removed ${item.title.split(" — ")[0]} from day ${day.dayNumber}; it won't come back in re-plans.`,
    constraintOps: [{ op: "add", constraint: exclude }],
  };
}

/**
 * Re-pick one day. Locked items stay; the day's other items are set aside so you get something
 * different (unless `vary` is false, e.g. "make day 2 more relaxed" should keep the best items).
 */
export async function regenerateDay(
  plan: Plan,
  dayNumber: number,
  constraints: Constraint[],
  opts: { instructions?: string; vary?: boolean; catalogue?: Catalogue } = {},
): Promise<PlanResponse & { explanation: string; constraintOps: ConstraintOp[] }> {
  const catalogue = opts.catalogue ?? loadCatalogue();
  const vary = opts.vary ?? true;
  let chat = planning(constraints);
  let ops: ConstraintOp[] = [];
  let fallbackNote = "";
  let extractLLM: import("../llm").LLMMeta | undefined;
  if (opts.instructions?.trim()) {
    const ex = await extractFromChat(opts.instructions, chat, extractContext(plan.input, catalogue), catalogue);
    // Instructions for "regenerate day N" apply to that day only where that makes sense.
    ops = ex.ops.map((o) => (o.op !== "remove" && DAY_SCOPABLE.has(o.constraint.type) ? { ...o, constraint: { ...o.constraint, scope: `day:${dayNumber}` } } : o));
    chat = applyOps(chat, ops);
    if (ex.fallback) fallbackNote = " (AI was unavailable, so your instructions were read with simple rules.)";
    extractLLM = ex.llm;
  }
  const prep = prepareFor(plan, chat, catalogue);
  const day = allDays(plan).find((d) => d.dayNumber === dayNumber);
  if (!day) throw new Error(`No day ${dayNumber}`);
  const leg = prep.assignInput.legs.find((l) => l.frames.some((f) => f.dayNumber === dayNumber))!;
  const frame = leg.frames.find((f) => f.dayNumber === dayNumber)!;
  const locked = lockedByDay(plan)[dayNumber] ?? [];
  const otherDays = new Set(allDays(plan).filter((d) => d.dayNumber !== dayNumber).flatMap(activityIds));
  const setAside = new Set(vary ? activityIds(day).filter((id) => !locked.includes(id)) : []);
  const pool = { ...leg.pool, pois: leg.pool.pois.filter((p) => !otherDays.has(p.id) && (!setAside.has(p.id) || locked.includes(p.id))) };
  const input: AssignInput = { legs: [{ ...leg, frames: [frame], pool }], levers: prep.resolved.levers, constraints: prep.constraints };

  const assignReport = { calls: [] as import("../llm").LLMMeta[], notes: [] as string[], fallbackDays: [] as number[], fullFallback: false };
  const assignFn = isAIEnabled()
    ? makeAIAssign({ locked: { [dayNumber]: locked }, preferences: opts.instructions ? [opts.instructions] : [], report: assignReport })
    : assignDaysHeuristic;
  const raw = applyLocked(await assignFn(input), { [dayNumber]: locked });
  const assigned = sanitizeAssignment(input, raw).result.days.find((d) => d.dayNumber === dayNumber) ?? { dayNumber, itemIds: locked };
  const res = spliceDay(plan, prep, { ...assigned, source: assigned.source ?? (isAIEnabled() ? "ai" : "planner") }, catalogue);
  const before = activityIds(day);
  const after = allDays(res.plan).find((d) => d.dayNumber === dayNumber)!;
  const response = dayResponse(res.plan, res.validation, prep, catalogue, chat);
  response.ai = aiInfo({ aiEnabled: isAIEnabled(), calls: [...(extractLLM ? [extractLLM] : []), ...assignReport.calls], fallbacks: assignReport.fullFallback ? ["day assignment: heuristic (AI unavailable)"] : [] });
  return {
    ...response,
    explanation: `Day ${dayNumber} re-planned: ${describeDayChange(before, after, catalogue) || "same places, re-timed"}.${fallbackNote}`,
    constraintOps: ops,
  };
}

/** Constraint types that can sensibly apply to a single day. */
const DAY_SCOPABLE = new Set<ConstraintType>(["pace", "day_window", "interest_weight", "avoid_tag", "poi_include", "poi_exclude"]);
/** Constraint types whose change needs route/nights recomputed. */
const FULL_SCOPE = new Set<ConstraintType>(["city_include", "city_exclude", "city_order", "nights_in_city", "date_anchor"]);

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export async function chat(args: {
  message?: string;
  answer?: { question: ClarifyingQuestion; option: string };
  /** Structured edits from the UI (e.g. removing a chip). */
  ops?: ConstraintOp[];
  tripInput: TripInput;
  constraints: Constraint[];
  plan?: Plan;
  catalogue?: Catalogue;
}): Promise<ChatResponse> {
  const catalogue = args.catalogue ?? loadCatalogue();
  const current = planning(args.constraints);
  let ex: Pick<ExtractResult, "intent" | "ops" | "clarifyingQuestions" | "warnings"> & { llm?: ExtractResult["llm"] };

  if (args.answer) {
    const op = answerQuestion(args.answer.question, args.answer.option, current);
    ex = op
      ? { intent: "add_constraints", ops: [op], clarifyingQuestions: [], warnings: [] }
      : await extractFromChat(args.answer.option, current, extractContext(args.tripInput, catalogue), catalogue);
  } else if (args.ops) {
    ex = { intent: "add_constraints", ops: rejectChips(args.ops, current, args.plan), clarifyingQuestions: [], warnings: [] };
  } else {
    ex = await extractFromChat(args.message ?? "", current, extractContext(args.tripInput, catalogue), catalogue);
  }
  const extraCalls = ex.llm ? [{ name: ex.llm.name, ms: ex.llm.ms, cached: ex.llm.cached, tokens: ex.llm.usage.totalTokens }] : [];
  const next = applyOps(current, ex.ops);
  const base = { intent: ex.intent, constraintOps: ex.ops, clarifyingQuestion: ex.clarifyingQuestions[0], clarifyingQuestions: ex.clarifyingQuestions };
  const fell = "fallback" in ex && ex.fallback ? " (AI was unavailable, so I read that with simple rules.)" : "";
  const warningText = (ex.warnings.length ? ` ${ex.warnings.join(" ")}` : "") + fell;

  if (ex.intent === "question" || ex.intent === "out_of_scope") {
    const msg = ex.intent === "out_of_scope"
      ? "I can only help with planning this Maharashtra trip."
      : "I can change the plan for you (e.g. \"make day 2 more relaxed\", \"remove Elephanta\", \"we are vegetarian\"), but I can't answer general questions yet.";
    return { ...base, changedScope: "none", explanation: msg + warningText };
  }
  if (!args.plan || (ex.ops.length === 0 && ex.intent !== "regenerate")) {
    const why = ex.clarifyingQuestions.length ? "I need one detail first." : "Nothing in the plan needed to change.";
    return { ...base, changedScope: "none", explanation: why + warningText };
  }

  const plan = args.plan;
  const scope = scopeFor(ex.intent, ex.ops, current, plan);
  if (scope.kind === "days-only" && scope.days.length === 0) {
    return { ...base, updated: undefined, changedScope: "none", explanation: `Noted — that isn't in the current plan, so nothing changed.${warningText}` };
  }
  let updated: PlanResponse;
  if (scope.kind === "reschedule") {
    // Keep every day's places exactly; only re-time and re-pick restaurants under the new constraints.
    const keep = Object.fromEntries(allDays(plan).map((d) => [d.dayNumber, activityIds(d)]));
    const keepFn = () => ({ days: allDays(plan).map((d) => ({ dayNumber: d.dayNumber, itemIds: keep[d.dayNumber], theme: d.title })), source: "planner" as const });
    const r = await planTrip(args.tripInput, next, { catalogue, locked: lockedByDay(plan), fixedLegs: legsOf(plan), assignOverride: keepFn });
    updated = toResponse(r, catalogue, ex.clarifyingQuestions, extraCalls);
  } else if (scope.kind === "days-only") {
    let p = plan;
    let resp: PlanResponse | null = null;
    for (const n of scope.days) {
      resp = await regenerateDay(p, n, next, { vary: false, catalogue });
      p = resp.plan;
    }
    updated = resp!;
  } else {
    const r = await planTrip(args.tripInput, next, {
      catalogue, locked: lockedByDay(plan), fixedLegs: scope.kind === "days" ? legsOf(plan) : undefined,
    });
    updated = toResponse(r, catalogue, ex.clarifyingQuestions, extraCalls);
  }
  const changedScope: ChatResponse["changedScope"] = scope.kind === "days-only" ? `day:${scope.days.join(",")}` : scope.kind === "reschedule" ? "days" : scope.kind;
  return { ...base, updated, changedScope, explanation: explain(ex.ops, plan, updated.plan, catalogue) + warningText };
}

/** Removing a planner chip (early start) means "don't do that": replace it with a hard day window at the normal start. */
function rejectChips(ops: ConstraintOp[], current: Constraint[], plan?: Plan): ConstraintOp[] {
  return ops.flatMap((o) => {
    if (o.op !== "remove" || !o.id.startsWith("auto-early-start-day-") || !plan) return [o];
    const day = o.id.replace("auto-early-start-day-", "");
    const hard: Constraint = {
      id: `chat-keep-start-day-${day}`, type: "day_window", params: { start: plan.levers.dayStart }, strength: "hard", weightLevel: "high",
      scope: `day:${day}`, source: "chat", sourceText: `keep the usual ${plan.levers.dayStart} start on day ${day}`, confidence: 1,
    };
    return current.some((c) => c.id === o.id) ? [o, { op: "add" as const, constraint: hard }] : [{ op: "add" as const, constraint: hard }];
  });
}

/** Constraint types that only change meals/timing, never which places are visited. */
const RESCHEDULE_ONLY = new Set<ConstraintType>(["dietary", "freeform"]);

type Scope = { kind: "full" } | { kind: "days" } | { kind: "reschedule" } | { kind: "days-only"; days: number[] };

/**
 * Smallest re-plan that honours the change:
 *   city / nights / dates → full · explicit day scope → those days · "skip X" → the day(s) X is on ·
 *   diet → keep places, re-time · pace / mobility / interests / other → re-pick all days, keep route + nights.
 */
function scopeFor(intent: ExtractResult["intent"], ops: ConstraintOp[], current: Constraint[], plan: Plan): Scope {
  if (intent === "regenerate") return { kind: "full" };
  const added = ops.filter((o) => o.op !== "remove").map((o) => (o as { constraint: Constraint }).constraint);
  const touched = ops.map((o) => (o.op === "remove" ? current.find((c) => c.id === o.id) : o.constraint)).filter((c): c is Constraint => !!c);
  if (touched.some((c) => FULL_SCOPE.has(c.type))) return { kind: "full" };
  const dayScoped = touched.filter((c) => c.scope.startsWith("day:"));
  if (touched.length && dayScoped.length === touched.length && touched.every((c) => DAY_SCOPABLE.has(c.type))) {
    return { kind: "days-only", days: [...new Set(dayScoped.map((c) => Number(c.scope.slice(4))))].sort((a, b) => a - b) };
  }
  // Adding exclusions only: re-plan just the day(s) that currently hold those places.
  if (added.length && added.length === ops.length && added.every((c) => c.type === "poi_exclude")) {
    const ids = new Set(added.map((c) => (c.params as { poiId: string }).poiId));
    return { kind: "days-only", days: allDays(plan).filter((d) => activityIds(d).some((id) => ids.has(id))).map((d) => d.dayNumber) };
  }
  if (touched.length && touched.every((c) => RESCHEDULE_ONLY.has(c.type))) return { kind: "reschedule" };
  return { kind: "days" };
}

function describeDayChange(before: string[], after: Day, catalogue: Catalogue): string {
  const name = (id: string) => catalogue.pois.find((p) => p.id === id)?.name ?? catalogue.experiences.find((x) => x.id === id)?.name ?? id;
  const now = activityIds(after);
  const added = now.filter((id) => !before.includes(id)).map(name);
  const removed = before.filter((id) => !now.includes(id)).map(name);
  return [removed.length ? `removed ${removed.join(", ")}` : "", added.length ? `added ${added.join(", ")}` : ""].filter(Boolean).join("; ");
}

/** A short "what changed" message: constraint changes, then per-day differences. */
function explain(ops: ConstraintOp[], before: Plan, after: Plan, catalogue: Catalogue): string {
  const parts: string[] = [];
  const describe = (c: Constraint) => c.sourceText ?? `${c.type} ${JSON.stringify(c.params)}`;
  const added = ops.filter((o) => o.op !== "remove").map((o) => (o as { constraint: Constraint }).constraint);
  const removed = ops.filter((o) => o.op === "remove").map((o) => before.constraints.find((c) => c.id === (o as { id: string }).id)).filter(Boolean) as Constraint[];
  if (added.length) parts.push(`Noted: ${added.map(describe).join("; ")}.`);
  if (removed.length) parts.push(`Dropped: ${removed.map(describe).join("; ")}.`);
  const changes: string[] = [];
  let unchanged = 0;
  for (const d of allDays(after)) {
    const old = allDays(before).find((x) => x.dayNumber === d.dayNumber);
    const diff = old ? describeDayChange(activityIds(old), d, catalogue) : "new day";
    if (diff) changes.push(`Day ${d.dayNumber}: ${diff}`); else unchanged++;
  }
  const nightsBefore = before.legs.map((l) => `${l.cityId}:${l.nights}`).join();
  const nightsAfter = after.legs.map((l) => `${l.cityId}:${l.nights}`).join();
  if (nightsBefore !== nightsAfter) parts.push(`Route/nights now: ${after.legs.map((l) => `${catalogue.cities.find((c) => c.id === l.cityId)?.name} ${l.nights}n`).join(" → ")}.`);
  parts.push(changes.length ? `${changes.join(". ")}.` : "The places stay the same; timings were re-checked.");
  if (changes.length && unchanged) parts.push(`${unchanged} other day(s) unchanged.`);
  return parts.join(" ");
}
