/**
 * Stage 4 — build the candidate pool for one leg.
 *
 * Hard filters remove what is impossible or unwanted; ranking orders the rest.
 * The pool is the ONLY set of IDs the day-assigner (heuristic or AI) may use.
 */
import type {
  Accessibility, City, Constraint, Event, Experience, Levers, Poi, PoiVariant, Restaurant, StageResult, Tier, WeightsFile,
} from "../types";
import { interestTags, ofType, travellerProfiles } from "./constraints";
import type { CandidatePool, FunnelStep, PlannerContext, PoolPoi, ScorePart } from "./plannerTypes";
import { monthOf, weekdayOf } from "./time";
import { startTrace } from "./trace";

const POOL_SIZE = 40;
const STAIRS = ["none", "low", "medium", "high"] as const;
const TIER_WEIGHT = { must_see: 1, worth_it: 0.6, niche: 0.3 } as const;
/** A single POI shouldn't use more than this share of the day's walking budget. */
const WALK_SHARE_PER_POI = 0.75;
/** A single ticket shouldn't exceed this share of the per-person daily budget. */
const PRICE_SHARE_OF_DAILY = 0.5;

// ---------------------------------------------------------------------------
// Mobility
// ---------------------------------------------------------------------------

export type MobilityRules = { maxStairs: (typeof STAIRS)[number]; allowSteep: boolean; flatOnly: boolean; maxWalkM: number; why: string[] };

export function mobilityRules(levers: Levers, constraints: Constraint[]): MobilityRules {
  const rules: MobilityRules = { maxStairs: "high", allowSteep: true, flatOnly: false, maxWalkM: levers.maxWalkKmPerDay * 1000 * WALK_SHARE_PER_POI, why: [] };
  const tighten = (stairs: MobilityRules["maxStairs"], why: string) => {
    if (STAIRS.indexOf(stairs) < STAIRS.indexOf(rules.maxStairs)) rules.maxStairs = stairs;
    rules.why.push(why);
  };
  for (const c of ofType(constraints, "mobility")) {
    if (c.params.level === "short_walks") { tighten("medium", `mobility short_walks (${c.id})`); rules.allowSteep = false; }
    if (c.params.level === "step_free") { tighten("none", `mobility step_free (${c.id})`); rules.allowSteep = false; rules.flatOnly = true; }
  }
  if (travellerProfiles(constraints).includes("elderly")) { tighten("medium", "elderly travellers"); rules.allowSteep = false; }
  rules.why.push(`max ${Math.round(rules.maxWalkM)}m walking per place (${WALK_SHARE_PER_POI} × maxWalkKmPerDay)`);
  return rules;
}

export function accessibilityFails(a: Accessibility, r: MobilityRules): string | null {
  if (STAIRS.indexOf(a.stairsLevel) > STAIRS.indexOf(r.maxStairs)) return `stairs ${a.stairsLevel} > ${r.maxStairs}`;
  if (r.flatOnly && a.terrain !== "flat") return `terrain ${a.terrain} (step-free needs flat)`;
  if (!r.allowSteep && a.terrain === "steep") return "steep terrain";
  if (a.walkingRequiredM > r.maxWalkM) return `${a.walkingRequiredM}m walking > ${Math.round(r.maxWalkM)}m`;
  return null;
}

export const applyVariant = (poi: Poi, v: PoiVariant): Accessibility => ({ ...poi.accessibility, ...v.accessibility });

/** Full POI if accessible, else the first variant that is, else a reason. */
export function accessibleVersion(poi: Poi, r: MobilityRules): { ok: true; variant: PoiVariant | null } | { ok: false; reason: string } {
  const fail = accessibilityFails(poi.accessibility, r);
  if (!fail) return { ok: true, variant: null };
  for (const v of poi.variants ?? []) {
    if (!accessibilityFails(applyVariant(poi, v), r)) return { ok: true, variant: v };
  }
  return { ok: false, reason: fail };
}

// ---------------------------------------------------------------------------
// Static (date-independent) filters — also used by allocateNights for demand
// ---------------------------------------------------------------------------

export function excludedReason(poi: Poi, constraints: Constraint[]): string | null {
  if (ofType(constraints, "poi_exclude").some((c) => c.params.poiId === poi.id)) return "excluded by user";
  const avoid = ofType(constraints, "avoid_tag").map((c) => c.params.tag);
  const hit = avoid.find((tag) => poi.interestTags.includes(tag) || poi.category === tag);
  if (hit) return `avoid tag "${hit}"`;
  if (interestTags(constraints).dislike.has(poi.category)) return `dislikes ${poi.category}`;
  return null;
}

export function priceCapPerPerson(city: City, tier: Tier, constraints: Constraint[], days: number, pax: number): number {
  let cap = city.avgDailyCostByTier[tier] * PRICE_SHARE_OF_DAILY;
  for (const c of ofType(constraints, "budget_cap")) {
    // Normalise every cap to "per person per day".
    const { amountINR, per } = c.params;
    const perPersonDay = per === "person_day" ? amountINR : per === "day" ? amountINR / pax : amountINR / pax / Math.max(1, days);
    cap = Math.min(cap, perPersonDay * 0.4);
  }
  return cap;
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

function rank(poi: Poi, variant: PoiVariant | null, dates: string[], constraints: Constraint[], weights: WeightsFile, requested: boolean): { score: number; parts: ScorePart[] } {
  const parts: ScorePart[] = [{ label: `tier ${poi.tier}`, value: TIER_WEIGHT[poi.tier] }];

  const { like, dislike } = interestTags(constraints);
  const tags = new Set([...poi.interestTags, poi.category]);
  let interest = 0;
  for (const [tag, c] of like) if (tags.has(tag)) interest += weights[c.weightLevel] * 0.5;
  for (const [tag, c] of dislike) if (tags.has(tag)) interest -= weights[c.weightLevel] * 0.7;
  interest = Math.min(0.6, interest);
  if (interest !== 0) parts.push({ label: "interest match", value: interest });

  const profiles = travellerProfiles(constraints);
  const suitScores = profiles.flatMap((p) =>
    p === "elderly" ? [poi.suitability.elderly] : p === "family_kids" ? [poi.suitability.kids] : p === "couple" ? [poi.suitability.couples] : [],
  );
  if (suitScores.length) {
    const avg = suitScores.reduce((a, b) => a + b, 0) / suitScores.length;
    parts.push({ label: `suitability (${profiles.join("+")})`, value: 0.4 * (avg - 0.5) });
  }

  parts.push({ label: "data confidence", value: -0.2 * (1 - poi.provenance.confidence) });
  if (dates.length && !dates.some((d) => poi.bestMonths.includes(monthOf(d)))) parts.push({ label: "off-season", value: -0.15 });
  if (variant) parts.push({ label: `variant (${variant.name})`, value: -0.05 });
  if (requested) parts.push({ label: "requested by user", value: 5 });

  const score = Math.round(parts.reduce((s, p) => s + p.value, 0) * 1000) / 1000;
  return { score, parts };
}

// ---------------------------------------------------------------------------

export function isOpenOn(poi: Poi, date: string, closedByEvent: Set<string>): boolean {
  const wd = weekdayOf(date);
  return !poi.weeklyOff.includes(wd) && poi.openingHours[wd].length > 0 && !closedByEvent.has(`${poi.id}|${date}`);
}

export function buildCandidatePool(args: {
  cityId: string;
  dates: string[];
  pois: Poi[];
  restaurants: Restaurant[];
  experiences: Experience[];
  cities: City[];
  events: Event[];
  levers: Levers;
  constraints: Constraint[];
  weights: WeightsFile;
  ctx: PlannerContext;
}): StageResult<CandidatePool> {
  const { cityId, dates, levers, constraints, weights, ctx } = args;
  const t = startTrace("buildCandidatePool", { cityId, dates, budgetTier: ctx.budgetTier });
  const city = args.cities.find((c) => c.id === cityId)!;
  const funnel: FunnelStep[] = [];
  const step = <T extends { id: string }>(label: string, items: T[], keep: (x: T) => string | null): T[] => {
    const removed: string[] = [];
    const kept = items.filter((x) => {
      const why = keep(x);
      if (why === null) return true;
      removed.push(`${x.id}: ${why}`);
      if (ctx.requestedPoiIds.has(x.id)) t.decide(`requested ${x.id} removed`, why);
      return false;
    });
    funnel.push({ step: label, remaining: kept.length, removed });
    return kept;
  };

  // Closure events (kind "closure") remove a POI on specific dates.
  const closedByEvent = new Set<string>();
  for (const ev of args.events.filter((e) => e.cityId === cityId && e.impact.kind === "closure")) {
    for (const d of dates) if (d >= ev.startDate && d <= ev.endDate) for (const p of ev.impact.affectedPoiIds) closedByEvent.add(`${p}|${d}`);
  }

  let pois = args.pois.filter((p) => p.cityId === cityId || p.isDayTripFrom === cityId);
  funnel.push({ step: "in city (incl. day trips)", remaining: pois.length, removed: [] });

  pois = step("not excluded", pois, (p) => excludedReason(p, constraints));
  pois = step("open on a leg date", pois, (p) => (dates.some((d) => isOpenOn(p, d, closedByEvent)) ? null : `closed on all of ${dates.map(weekdayOf).join(", ")}`));

  const rules = mobilityRules(levers, constraints);
  t.decide("mobility rules", rules.why.join("; "), rules);
  const variantOf = new Map<string, PoiVariant | null>();
  pois = step("mobility", pois, (p) => {
    const v = accessibleVersion(p, rules);
    if (!v.ok) return v.reason;
    variantOf.set(p.id, v.variant);
    if (v.variant) t.decide(`${p.id} → variant "${v.variant.name}"`, `full visit fails mobility: ${accessibilityFails(p.accessibility, rules)}`);
    return null;
  });

  const priceCap = priceCapPerPerson(city, ctx.budgetTier, constraints, dates.length, ctx.pax);
  pois = step("budget", pois, (p) => (p.priceINR > priceCap ? `₹${p.priceINR} > ₹${Math.round(priceCap)} per person cap` : null));

  const ranked: PoolPoi[] = pois.map((poi) => {
    const variant = variantOf.get(poi.id) ?? null;
    const requested = ctx.requestedPoiIds.has(poi.id);
    const { score, parts } = rank(poi, variant, dates, constraints, weights, requested);
    return {
      id: poi.id,
      poi,
      variant,
      durationMin: Math.round((variant?.durationMin.typical ?? poi.durationMin.typical) * levers.durationMultiplier),
      accessibility: variant ? applyVariant(poi, variant) : poi.accessibility,
      score,
      scoreParts: parts,
      openDates: dates.filter((d) => isOpenOn(poi, d, closedByEvent)),
      isDayTrip: poi.isDayTripFrom !== null,
      requested,
    };
  });
  ranked.sort((a, b) => b.score - a.score);
  const top = ranked.slice(0, POOL_SIZE);
  funnel.push({ step: `top ${POOL_SIZE} by score`, remaining: top.length, removed: ranked.slice(POOL_SIZE).map((p) => p.id) });

  // Restaurants: diet is hard; budget excludes premium for budget travellers.
  const diets = ofType(constraints, "dietary").map((c) => c.params.diet);
  const restaurants = args.restaurants.filter((r) => {
    if (r.cityId !== cityId) return false;
    if (diets.includes("jain") && !r.dietary.jain) return false;
    if (diets.includes("veg") && !r.dietary.veg) return false;
    if (ctx.budgetTier === "budget" && r.priceBand === "premium") return false;
    return true;
  });

  const experiences = args.experiences
    .filter((x) => x.cityId === cityId && !accessibilityFails(x.accessibility, rules) && x.priceINR <= priceCap * 2)
    .map((experience) => ({
      id: experience.id,
      experience,
      score: experience.interestTags.filter((tag) => interestTags(constraints).like.has(tag)).length * 0.3,
      operatingDates: dates.filter((d) => experience.daysOperating.includes(weekdayOf(d))),
    }))
    .filter((x) => x.operatingDates.length > 0);

  return t.finish({ cityId, pois: top, restaurants, experiences, funnel }, {
    funnel: funnel.map((f) => `${f.step}: ${f.remaining}`),
    top10: top.slice(0, 10).map((p) => `${p.id} (${p.score}${p.variant ? `, variant: ${p.variant.name}` : ""})`),
    restaurants: restaurants.length,
    experiences: experiences.map((x) => x.id),
  });
}
