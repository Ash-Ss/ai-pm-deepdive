/**
 * Narration: one LLM call turns a code-built fact sheet into friendly text.
 *
 * The LLM never writes place names. It refers to entities only by tokens —
 * {{poi:ID}}, {{rest:ID}}, {{city:ID}}, {{exp:ID}} — and code:
 *   1. checks every token names an entity that is in this plan,
 *   2. checks what's left: every number must appear in the fact sheet, and every
 *      capitalised word must be on an allowlist (common words, weekdays, months,
 *      city names from the data) — so a name typed out directly fails,
 *   3. renders tokens to names.
 * A text that fails any check is replaced by a template built from the same facts.
 */
import { z } from "zod";
import type { Catalogue } from "../catalogue";
import { callLLM, type LLMMeta } from "../llm";
import type { PipelineResult } from "../planner/pipeline";

// ---------------------------------------------------------------------------
// Entities and tokens
// ---------------------------------------------------------------------------

export type EntityKind = "poi" | "rest" | "city" | "exp";
export type Entity = { token: string; kind: EntityKind; id: string; name: string };
const TOKEN_RE = /\{\{(poi|rest|city|exp):([a-z0-9][a-z0-9_-]*)\}\}/g;
const tokenOf = (kind: EntityKind, id: string) => `{{${kind}:${id}}}`;

/** Every entity the plan mentions, keyed by token. */
export function planEntities(result: PipelineResult, catalogue: Catalogue): Map<string, Entity> {
  const out = new Map<string, Entity>();
  const add = (kind: EntityKind, id: string, name: string | undefined) => {
    if (name) out.set(tokenOf(kind, id), { token: tokenOf(kind, id), kind, id, name });
  };
  for (const leg of result.plan.legs) {
    add("city", leg.cityId, catalogue.cities.find((c) => c.id === leg.cityId)?.name);
    for (const day of leg.days) {
      for (const i of day.items) {
        if (!i.refId) continue;
        if (i.type === "activity") {
          add("poi", i.refId, catalogue.pois.find((p) => p.id === i.refId)?.name);
          add("exp", i.refId, catalogue.experiences.find((x) => x.id === i.refId)?.name);
        }
        if (i.type === "meal") add("rest", i.refId, catalogue.restaurants.find((r) => r.id === i.refId)?.name);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fact sheet (entities appear as tokens; names are listed once in `entities`)
// ---------------------------------------------------------------------------

export type FactSheet = {
  entities: { token: string; name: string }[];
  travellers: string;
  totalDays: number;
  route: { order: string[]; hops: string[]; transitHours: number };
  legs: { city: string; nights: number; baseArea: string }[];
  days: {
    dayNumber: number;
    date: string;
    weekday: string;
    city: string;
    theme: string;
    items: {
      itemId: string;
      type: string;
      entity: string | null;
      start: string;
      end: string;
      minutes: number;
      facts: string[];
      whySelected: string[];
      tradeoffs: string[];
    }[];
  }[];
};

const hm = (min: number) => `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ""}`;
const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

export function buildFactSheet(result: PipelineResult, entities: Map<string, Entity>): FactSheet {
  const { plan, debug } = result;
  const t = plan.input.travellers;
  const best = debug.route.best;
  const city = (id: string) => tokenOf("city", id);
  const entityFor = (type: string, refId: string | null) => {
    if (!refId) return null;
    const kinds: EntityKind[] = type === "meal" ? ["rest"] : type === "activity" ? ["poi", "exp"] : [];
    return kinds.map((k) => tokenOf(k, refId)).find((tok) => entities.has(tok)) ?? null;
  };
  return {
    entities: [...entities.values()].map((e) => ({ token: e.token, name: e.name })),
    travellers: `${t.adults} adults${t.seniors ? `, ${t.seniors} seniors` : ""}${t.children ? `, ${t.children} children` : ""}; ${plan.input.presets.join(", ") || "no presets"}`,
    totalDays: plan.input.days,
    route: {
      order: best.order.map(city),
      hops: best.hops.map((h) => `${city(h.from)} to ${city(h.to)} by ${h.edge.mode}, about ${hm(h.minutes)} door to door`),
      transitHours: best.breakdown.transitHours,
    },
    legs: plan.legs.map((l) => ({ city: city(l.cityId), nights: l.nights, baseArea: debug.hotels.get(l.cityId)!.area.name })),
    days: plan.legs.flatMap((l) => l.days).map((d) => ({
      dayNumber: d.dayNumber,
      date: d.date ?? "",
      weekday: new Date(`${d.date}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" }),
      city: city(d.cityId),
      theme: d.title ?? "",
      items: d.items
        .filter((i) => i.type === "activity" || i.type === "meal" || i.tradeoffs.length > 0)
        .map((i) => {
          const p = i.refId ? debug.pools.get(d.cityId)?.pois.find((x) => x.id === i.refId) : undefined;
          const facts: string[] = [];
          if (p) {
            facts.push(`category ${p.poi.category}; tags ${p.poi.interestTags.join(", ")}`);
            facts.push(`stairs ${p.accessibility.stairsLevel}, terrain ${p.accessibility.terrain}, about ${p.accessibility.walkingRequiredM} m walking${p.accessibility.seating ? ", seating available" : ""}`);
            if (p.poi.priceINR) facts.push(`entry about ₹${p.poi.priceINR} per person`);
          }
          return {
            itemId: i.id, type: i.type, entity: entityFor(i.type, i.refId), start: i.startTime, end: i.endTime,
            minutes: toMinutes(i.endTime) - toMinutes(i.startTime),
            facts, whySelected: i.whySelected, tradeoffs: i.tradeoffs,
          };
        }),
    })),
  };
}

// ---------------------------------------------------------------------------
// Grounding
// ---------------------------------------------------------------------------

/**
 * Capitalised words allowed in narration. Everything else capitalised is
 * assumed to be a name, and names must come through tokens.
 */
const COMMON_CAPS = new Set(`
a an the and but or so yet for nor as at by in on of to from with without into onto over under after before during since until while
i you your yours we our ours they their it its this that these those there here he she his her them
is are was were be been being have has had do does did will would can could should may might must shall
if when where why how what which who whom whose once then next finally later also still just even only
today tonight tomorrow morning afternoon evening night day days weekend week
start begin end finish head take make spend enjoy explore discover visit see stroll walk wander drive fly board catch
relax rest unwind pause linger settle check arrive leave return continue wrap round ease kick savour taste try sample
browse shop admire marvel soak keep allow expect note please plan give get let set use choose pick
lunch dinner breakfast tea coffee chai snack meal
a highlight highlights perfect ideal great good gentle easy short quick long slow calm quiet lovely beautiful
first second third last final another other each every both all most many some few more less
because although though however instead meanwhile afterwards overall together
monday tuesday wednesday thursday friday saturday sunday
january february march april may june july august september october november december
unesco india indian maharashtra maratha mughal buddhist hindu jain shiva ganesh am pm ok
focus dedicate conclude complete experience learn feel find follow join meet watch listen stay reach climb cross hop ride
around across along near nearby inside outside beyond between through throughout toward towards within
full whole half early late slowly gently well plenty time
cave caves fort forts temple temples museum museums lake lakes market markets garden gardens beach beaches
palace tomb mausoleum shrine church mosque monument monuments site sites viewpoint point hill hills city town old
station airport hotel restaurant cafe tour guide car taxi flight train
`.split(/\s+/).filter(Boolean));

/** "Visiting", "Explores", "Settled" → their base word, so verb forms of allowed words pass. */
function allowedWord(word: string, allowed: Set<string>): boolean {
  if (allowed.has(word)) return true;
  const stems = [word.replace(/ing$/, ""), word.replace(/ing$/, "e"), word.replace(/(ed|es|s|d)$/, ""), word.replace(/ies$/, "y")];
  return stems.some((s) => s.length > 2 && allowed.has(s));
}

const NUMBER_RE = /\d+(?:[.,:]\d+)*/g;
const CAP_WORD_RE = /\b[A-Z][\p{L}'’]*/gu;

function numberVariants(token: string): string[] {
  const noCommas = token.replace(/,/g, "");
  const out = new Set([token, noCommas]);
  const time = /^(\d{1,2}):(\d{2})$/.exec(token);
  if (time) { out.add(`${time[1].padStart(2, "0")}:${time[2]}`); out.add(`${Number(time[1])}:${time[2]}`); }
  if (/^\d+\.0$/.test(noCommas)) out.add(noCommas.replace(/\.0$/, ""));
  return [...out];
}

/**
 * Rewrites must keep the facts a note exists to convey: clock times and ₹ amounts
 * ("starts at 08:30 instead of 10:30"). Numbers inside names ("Caves 1, 2, 16") may go.
 */
const KEY_FACT_RE = /\b\d{1,2}:\d{2}\b|₹\s?[\d,]+/g;
export function droppedNumbers(original: string, rewritten: string): string[] {
  const kept = new Set((rewritten.match(NUMBER_RE) ?? []).flatMap(numberVariants));
  return (original.match(KEY_FACT_RE) ?? [])
    .map((f) => f.replace(/₹\s?/, ""))
    .filter((n) => !numberVariants(n).some((v) => kept.has(v)));
}

export type GroundingContext = { factNumbers: Set<string>; entities: Map<string, Entity>; allowedCaps: Set<string> };

export function groundingContext(facts: FactSheet, entities: Map<string, Entity>, catalogue: Catalogue): GroundingContext {
  // Item ids like "d1-7" and tokens like {{poi:x}} are labels, not facts — keep their digits out.
  const factText = JSON.stringify(facts, (k, v) => (k === "itemId" || k === "entities" ? undefined : v)).replace(TOKEN_RE, "");
  const cityWords = catalogue.cities.flatMap((c) => c.name.split(/[\s()]+/)).map((w) => w.toLowerCase()).filter(Boolean);
  return {
    factNumbers: new Set((factText.match(NUMBER_RE) ?? []).flatMap(numberVariants)),
    entities,
    allowedCaps: new Set([...COMMON_CAPS, ...cityWords]),
  };
}

export function groundingIssues(text: string, g: GroundingContext): string[] {
  const issues: string[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    if (!g.entities.has(m[0])) issues.push(`token ${m[0]} is not in this plan`);
  }
  // Stray braces mean a malformed token.
  const stripped = text.replace(TOKEN_RE, " ");
  if (/[{}]/.test(stripped)) issues.push("malformed token");
  for (const n of stripped.match(NUMBER_RE) ?? []) {
    if (!numberVariants(n).some((v) => g.factNumbers.has(v))) issues.push(`number "${n}" not in facts`);
  }
  for (const w of stripped.match(CAP_WORD_RE) ?? []) {
    const word = w.replace(/['’]s$/, "").toLowerCase();
    if (!allowedWord(word, g.allowedCaps)) issues.push(`capitalised "${w}" is not a token or common word`);
  }
  return issues;
}

export function renderTokens(text: string, entities: Map<string, Entity>): string {
  return text.replace(TOKEN_RE, (tok) => entities.get(tok)?.name ?? tok);
}

// ---------------------------------------------------------------------------
// LLM call + templates
// ---------------------------------------------------------------------------

export const NarrationOutput = z.object({
  tripSummary: z.string().max(600),
  routeReason: z.string().max(400),
  days: z.array(z.object({ dayNumber: z.number().int(), intro: z.string().max(300) })),
  items: z.array(z.object({ itemId: z.string(), why: z.string().max(220) })),
  tradeoffs: z.array(z.object({ itemId: z.string(), index: z.number().int().min(0), text: z.string().max(260) })),
});
export type NarrationOutput = z.infer<typeof NarrationOutput>;

export const NARRATE_SYSTEM = `You write short, warm, practical narration for a trip itinerary. Return JSON only.
NAMES: never write the name of a place, restaurant, city or tour. Refer to them ONLY with the tokens from "entities",
copied exactly, e.g. "Start at {{poi:gateway-of-india}}" or "dinner at {{rest:leopold-cafe}}". Do not invent tokens.
Do not use any other proper nouns (no sub-site, cave or temple names that are not tokens). Use sentence case:
only the first word of a sentence is capitalised, and start sentences with ordinary words.
FACTS: use only the facts provided. Do not add any number, time, price or distance that is not in the facts.
Prefer describing over quantifying if unsure. British/Indian English. No emojis. No exclamation marks.
- tripSummary: 2–3 sentences about the whole trip and who it's for.
- routeReason: 1–2 sentences on why the cities are in this order (use the route facts).
- days[].intro: 1–2 sentences per day.
- items[].why: for each activity item, why it's worth it for these travellers, at most 30 words.
- tradeoffs[]: rewrite each tradeoff note (by itemId and its index in that item's tradeoffs list) kindly and clearly, keeping every time and price.`;

export type NarrationReport = { llm?: LLMMeta; replaced: { where: string; issues: string[] }[]; source: "ai" | "template" | "mixed" };

function templates(result: PipelineResult, catalogue: Catalogue) {
  const cityName = (id: string) => catalogue.cities.find((c) => c.id === id)?.name ?? id;
  const t = result.plan.input.travellers;
  const who = `${t.adults} adults${t.seniors ? ` and ${t.seniors} seniors` : ""}${t.children ? ` and ${t.children} children` : ""}`;
  const best = result.debug.route.best;
  const order = best.order.map(cityName);
  return {
    tripSummary: `A ${result.plan.input.days}-day trip through ${order.join(" and ")} for ${who}.`,
    routeReason: best.hops.length
      ? `Route: ${order.join(" → ")}, chosen for the least time in transit (${best.hops.map((h) => `${cityName(h.from)} to ${cityName(h.to)} by ${h.edge.mode}, about ${hm(h.minutes)}`).join("; ")}).`
      : `A single-base trip in ${order[0]}.`,
    dayIntro: (dayNumber: number, cityId: string, activityTitles: string[]) =>
      activityTitles.length ? `Day ${dayNumber} in ${cityName(cityId)}: ${activityTitles.join(", ")}.` : `Day ${dayNumber} in ${cityName(cityId)}: an easy day.`,
    itemWhy: (why: string[]) => (why.length ? `Chosen because: ${why.join("; ")}.` : ""),
  };
}

/** Narrate a planned trip in place (mutates plan text fields) and report what was replaced. */
export async function narratePlan(result: PipelineResult, catalogue: Catalogue, useAI: boolean): Promise<NarrationReport> {
  const entities = planEntities(result, catalogue);
  const facts = buildFactSheet(result, entities);
  const tpl = templates(result, catalogue);
  const report: NarrationReport = { replaced: [], source: "template" };
  const plan = result.plan;

  let ai: NarrationOutput | null = null;
  if (useAI) {
    try {
      const r = await callLLM({ name: "narrate", system: NARRATE_SYSTEM, prompt: `FACTS:\n${JSON.stringify(facts)}`, schema: NarrationOutput, temperature: 0.6 });
      ai = r.data;
      report.llm = r.meta;
    } catch (e) {
      report.replaced.push({ where: "all", issues: [`AI narration unavailable: ${(e as Error).message.slice(0, 160)}`] });
    }
  }

  const g = groundingContext(facts, entities, catalogue);
  let aiUsed = 0;
  let tplUsed = 0;
  /** Use the (rendered) AI text if it passes every check, else the template. */
  const pick = (where: string, aiText: string | undefined, fallback: string, mustKeepFrom?: string): string => {
    if (aiText === undefined) { tplUsed++; return fallback; }
    const issues = groundingIssues(aiText, g);
    const rendered = renderTokens(aiText, entities);
    if (mustKeepFrom) issues.push(...droppedNumbers(mustKeepFrom, rendered).map((n) => `dropped "${n}" from the original note`));
    if (issues.length) {
      report.replaced.push({ where, issues });
      tplUsed++;
      return fallback;
    }
    aiUsed++;
    return rendered;
  };

  plan.summary = {
    trip: pick("tripSummary", ai?.tripSummary, tpl.tripSummary),
    route: pick("routeReason", ai?.routeReason, tpl.routeReason),
    source: "template",
  };
  for (const day of plan.legs.flatMap((l) => l.days)) {
    const acts = day.items.filter((i) => i.type === "activity").map((i) => i.title.split(" — ")[0]);
    day.intro = pick(`day ${day.dayNumber} intro`, ai?.days.find((d) => d.dayNumber === day.dayNumber)?.intro, tpl.dayIntro(day.dayNumber, day.cityId, acts));
    for (const item of day.items) {
      if (item.type === "activity") {
        const why = pick(`${item.id} why`, ai?.items.find((x) => x.itemId === item.id)?.why, tpl.itemWhy(item.whySelected));
        item.narration = why || null;
      }
      item.tradeoffs = item.tradeoffs.map((orig, idx) =>
        pick(`${item.id} tradeoff ${idx}`, ai?.tradeoffs.find((x) => x.itemId === item.id && x.index === idx)?.text, orig, orig));
    }
  }
  report.source = aiUsed && tplUsed ? "mixed" : aiUsed ? "ai" : "template";
  plan.summary.source = report.source;
  return report;
}

/** Template narration for one edited day (swap/remove/regenerate make no narration call). */
export function templateNarrateDay(day: import("../types").Day, catalogue: Catalogue): void {
  const city = catalogue.cities.find((c) => c.id === day.cityId)?.name ?? day.cityId;
  const acts = day.items.filter((i) => i.type === "activity").map((i) => i.title.split(" — ")[0]);
  day.intro = acts.length ? `Day ${day.dayNumber} in ${city}: ${acts.join(", ")}.` : `Day ${day.dayNumber} in ${city}: an easy day.`;
  for (const i of day.items) if (i.type === "activity") i.narration = i.whySelected.length ? `Chosen because: ${i.whySelected.join("; ")}.` : null;
}
