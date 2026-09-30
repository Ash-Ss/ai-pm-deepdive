/**
 * Narration: one LLM call turns a code-built fact sheet into friendly text.
 *
 * Grounding check (code): every number in a generated text must appear in the
 * fact sheet, and every capitalised name must exist in the fact sheet. A text
 * that fails is replaced by a template built from the same facts, so the plan
 * never shows an invented time, price or place.
 */
import { z } from "zod";
import { callLLM, type LLMMeta } from "../llm";
import type { PipelineResult } from "../planner/pipeline";

// ---------------------------------------------------------------------------
// Fact sheet
// ---------------------------------------------------------------------------

export type FactSheet = {
  travellers: string;
  totalDays: number;
  route: { order: string[]; hops: string[]; transitHours: number; alternativesConsidered: string[] };
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
      title: string;
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

export function buildFactSheet(result: PipelineResult, cityName: (id: string) => string): FactSheet {
  const { plan, debug } = result;
  const t = plan.input.travellers;
  const pools = debug.pools;
  const best = debug.route.best;
  return {
    travellers: `${t.adults} adults${t.seniors ? `, ${t.seniors} seniors` : ""}${t.children ? `, ${t.children} children` : ""}; ${plan.input.presets.join(", ") || "no presets"}`,
    totalDays: plan.input.days,
    route: {
      order: best.order.map(cityName),
      hops: best.hops.map((h) => `${cityName(h.from)} to ${cityName(h.to)} by ${h.edge.mode}, about ${hm(h.minutes)} door to door`),
      transitHours: best.breakdown.transitHours,
      alternativesConsidered: debug.route.ranked.slice(1, 3).map((r) => `${r.order.map(cityName).join(" → ")} (score ${r.score})`),
    },
    legs: plan.legs.map((l) => ({ city: cityName(l.cityId), nights: l.nights, baseArea: debug.hotels.get(l.cityId)!.area.name })),
    days: plan.legs.flatMap((l) => l.days).map((d) => ({
      dayNumber: d.dayNumber,
      date: d.date ?? "",
      weekday: new Date(`${d.date}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" }),
      city: cityName(d.cityId),
      theme: d.title ?? "",
      items: d.items
        .filter((i) => i.type === "activity" || i.tradeoffs.length > 0)
        .map((i) => {
          const p = i.refId ? pools.get(d.cityId)?.pois.find((x) => x.id === i.refId) : undefined;
          const facts: string[] = [];
          if (p) {
            facts.push(p.poi.shortDescription);
            facts.push(`stairs ${p.accessibility.stairsLevel}, terrain ${p.accessibility.terrain}, about ${p.accessibility.walkingRequiredM} m walking${p.accessibility.seating ? ", seating available" : ""}`);
            if (p.poi.priceINR) facts.push(`entry about ₹${p.poi.priceINR} per person`);
          }
          const minutes = toMinutes(i.endTime) - toMinutes(i.startTime);
          return {
            itemId: i.id, type: i.type, title: i.title, start: i.startTime, end: i.endTime, minutes,
            facts, whySelected: i.whySelected, tradeoffs: i.tradeoffs,
          };
        }),
    })),
  };
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

// ---------------------------------------------------------------------------
// Grounding
// ---------------------------------------------------------------------------

/** Words that may be capitalised without being a place from the plan. */
const GENERIC_CAPS = new Set([
  "i", "day", "days", "your", "you", "we", "our", "the", "a", "an", "this", "that", "it", "enjoy", "start", "end", "after", "before", "then",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
  "unesco", "india", "indian", "maharashtra", "maratha", "mughal", "buddhist", "hindu", "jain", "shiva", "ganesh", "am", "pm",
]);

const NUMBER_RE = /\d+(?:[.,:]\d+)*/g;
// "of", "ka", "de", "the" can sit inside a name (Gateway of India, Bibi Ka Maqbara); "and"/"&" join two names.
const CAPS_RE = /[A-Z][\p{L}'’\-]*(?:\s+(?:(?:of|the|ka|de)\s+)*[A-Z][\p{L}'’\-]*)*/gu;

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

export function groundingIssues(text: string, factText: string): string[] {
  const issues: string[] = [];
  const factNumbers = new Set((factText.match(NUMBER_RE) ?? []).flatMap(numberVariants));
  for (const n of text.match(NUMBER_RE) ?? []) {
    if (!numberVariants(n).some((v) => factNumbers.has(v))) issues.push(`number "${n}" not in facts`);
  }
  const lowerFacts = factText.toLowerCase();
  // A single capitalised word right after a sentence boundary is usually just grammar ("Enjoy…").
  for (const m of text.matchAll(CAPS_RE)) {
    const phrase = m[0];
    const words = phrase.split(/\s+/);
    const before = text.slice(0, m.index).trimEnd();
    const sentenceStart = before === "" || /[.!?:;—–-]$/.test(before);
    if (words.length === 1 && sentenceStart) continue;
    if (words.every((w) => GENERIC_CAPS.has(w.toLowerCase().replace(/['’]s$/, "")))) continue;
    const known = (p: string) => lowerFacts.includes(p.replace(/['’]s$/, "").toLowerCase());
    // At a sentence start the first word may just be grammar ("Enjoy Bibi Ka Maqbara").
    const ok = known(phrase) || (sentenceStart && words.length > 1 && known(words.slice(1).join(" ")));
    if (!ok) issues.push(`name "${phrase}" not in plan`);
  }
  return issues;
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
Use ONLY the facts provided. Do not add any number, time, price, distance or place name that is not in the facts.
Prefer describing over quantifying if unsure. British/Indian English. No emojis. No exclamation marks.
- tripSummary: 2–3 sentences about the whole trip and who it's for.
- routeReason: 1–2 sentences on why the cities are in this order (use the route facts).
- days[].intro: 1–2 sentences per day.
- items[].why: for each activity item, why it's worth it for these travellers, at most 30 words.
- tradeoffs[]: rewrite each tradeoff note (by itemId and its index in that item's tradeoffs list) kindly and clearly, keeping every time and fact.`;

export type NarrationReport = { llm?: LLMMeta; replaced: { where: string; issues: string[] }[]; source: "ai" | "template" | "mixed" };

function templates(facts: FactSheet) {
  return {
    tripSummary: `A ${facts.totalDays}-day trip through ${facts.route.order.join(" and ")} for ${facts.travellers.split(";")[0]}.`,
    routeReason: facts.route.hops.length
      ? `Route: ${facts.route.order.join(" → ")}, chosen for the least time in transit (${facts.route.hops.join("; ")}).`
      : `A single-base trip in ${facts.route.order[0]}.`,
    dayIntro: (d: FactSheet["days"][number]) => {
      const acts = d.items.filter((i) => i.type === "activity").map((i) => i.title.split(" — ")[0]);
      return acts.length ? `Day ${d.dayNumber} in ${d.city}: ${acts.join(", ")}.` : `Day ${d.dayNumber} in ${d.city}: an easy day.`;
    },
    itemWhy: (i: FactSheet["days"][number]["items"][number]) => (i.whySelected.length ? `Chosen because: ${i.whySelected.join("; ")}.` : ""),
  };
}

/** Narrate a planned trip in place (mutates plan text fields) and report what was replaced. */
export async function narratePlan(result: PipelineResult, cityName: (id: string) => string, useAI: boolean): Promise<NarrationReport> {
  const facts = buildFactSheet(result, cityName);
  const tpl = templates(facts);
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

  // Item ids like "d1-7" are labels, not facts — keep their digits out of the allowed numbers.
  const factText = JSON.stringify(facts, (k, v) => (k === "itemId" ? undefined : v));
  let aiUsed = 0;
  let tplUsed = 0;
  /** Use the AI text if it passes grounding, else the template. */
  const pick = (where: string, aiText: string | undefined, fallback: string, mustKeepFrom?: string): string => {
    if (aiText === undefined) { tplUsed++; return fallback; }
    const issues = groundingIssues(aiText, factText);
    if (mustKeepFrom) issues.push(...droppedNumbers(mustKeepFrom, aiText).map((n) => `dropped "${n}" from the original note`));
    if (issues.length) {
      report.replaced.push({ where, issues });
      tplUsed++;
      return fallback;
    }
    aiUsed++;
    return aiText;
  };

  plan.summary = {
    trip: pick("tripSummary", ai?.tripSummary, tpl.tripSummary),
    route: pick("routeReason", ai?.routeReason, tpl.routeReason),
    source: "template",
  };
  for (const day of plan.legs.flatMap((l) => l.days)) {
    const f = facts.days.find((x) => x.dayNumber === day.dayNumber)!;
    day.intro = pick(`day ${day.dayNumber} intro`, ai?.days.find((d) => d.dayNumber === day.dayNumber)?.intro, tpl.dayIntro(f));
    for (const item of day.items) {
      if (item.type === "activity") {
        const fi = f.items.find((x) => x.itemId === item.id);
        const why = pick(`${item.id} why`, ai?.items.find((x) => x.itemId === item.id)?.why, fi ? tpl.itemWhy(fi) : "");
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

