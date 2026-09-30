/**
 * Core data model for the Maharashtra trip planner.
 *
 * Zod schemas are the single source of truth; TS types are inferred from them
 * so the runtime validation (catalogue JSON, LLM output) and the compile-time
 * types can never drift apart.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** "HH:MM", 24h. Strings (not minutes) so JSON data stays human-editable. */
export const TimeHHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:MM (24h)");
export type TimeHHMM = z.infer<typeof TimeHHMM>;

/** ISO calendar date "YYYY-MM-DD". */
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

/** Slug-style IDs, e.g. "mumbai", "pune-shaniwar-wada". */
export const Id = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "Expected lowercase slug id");

export const Weekday = z.enum([
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
]);
export type Weekday = z.infer<typeof Weekday>;

/** Calendar month, 1 = January. Numbers avoid spelling/locale mismatches. */
export const Month = z.number().int().min(1).max(12);

export const Score01 = z.number().min(0).max(1);

export const Tier = z.enum(["budget", "mid", "premium"]);
export type Tier = z.infer<typeof Tier>;

/** A value per budget tier (INR). */
export const ByTierINR = z.object({
  budget: z.number().nonnegative(),
  mid: z.number().nonnegative(),
  premium: z.number().nonnegative(),
});

export const TimeWindow = z.object({ start: TimeHHMM, end: TimeHHMM });
export type TimeWindow = z.infer<typeof TimeWindow>;

// ---------------------------------------------------------------------------
// Shared sub-shapes (POIs and experiences use the same ones)
// ---------------------------------------------------------------------------

export const Suitability = z.object({
  kids: Score01,
  elderly: Score01,
  couples: Score01,
});
export type Suitability = z.infer<typeof Suitability>;

export const Accessibility = z.object({
  stairsLevel: z.enum(["none", "low", "medium", "high"]),
  terrain: z.enum(["flat", "mixed", "steep"]),
  walkingRequiredM: z.number().nonnegative(),
  seating: z.boolean(),
});
export type Accessibility = z.infer<typeof Accessibility>;

export const DurationRange = z
  .object({
    min: z.number().int().positive(),
    typical: z.number().int().positive(),
    max: z.number().int().positive(),
  })
  .refine((d) => d.min <= d.typical && d.typical <= d.max, "Expected min ≤ typical ≤ max");
export type DurationRange = z.infer<typeof DurationRange>;

/** Per-weekday list of [open, close] ranges; [] = closed that day. */
export const OpeningHours = z.record(Weekday, z.array(z.tuple([TimeHHMM, TimeHHMM])));
export type OpeningHours = z.infer<typeof OpeningHours>;

// ---------------------------------------------------------------------------
// City
// ---------------------------------------------------------------------------

export const Area = z.object({
  id: Id,
  name: z.string(),
  lat: z.number(),
  lng: z.number(),
  vibeTags: z.array(z.string()),
  walkability: z.number().int().min(1).max(5),
  /** INR per night, typical double room. */
  hotelPriceBand: ByTierINR,
  goodFor: z.array(z.string()),
});
export type Area = z.infer<typeof Area>;

export const City = z.object({
  id: Id,
  name: z.string(),
  lat: z.number(),
  lng: z.number(),
  minNights: z.number().int().nonnegative(),
  /** Nights after which extra time adds little value — used to cap allocation. */
  saturationNights: z.number().int().positive(),
  gatewayFor: z.array(z.enum(["airport", "rail", "bus"])),
  bestMonths: z.array(Month),
  /** Per person per day, excluding hotel. */
  avgDailyCostByTier: ByTierINR,
  areas: z.array(Area).min(1),
});
export type City = z.infer<typeof City>;

// ---------------------------------------------------------------------------
// POI
// ---------------------------------------------------------------------------

export const PoiCategory = z.enum([
  "fort", "temple", "cave", "museum", "beach", "viewpoint", "market",
  "neighbourhood", "park", "landmark", "experience", "lake", "waterfall",
]);
export type PoiCategory = z.infer<typeof PoiCategory>;

export const TimeOfDay = z.enum(["morning", "afternoon", "evening", "sunset", "any"]);
export type TimeOfDay = z.infer<typeof TimeOfDay>;

/** A lighter way to do the same place (e.g. "lower caves only"). */
export const PoiVariant = z.object({
  name: z.string(),
  durationMin: DurationRange,
  accessibility: Accessibility.partial(),
});
export type PoiVariant = z.infer<typeof PoiVariant>;

export const Provenance = z.object({
  source: z.enum(["curated", "ai_draft"]),
  confidence: Score01,
});

export const Poi = z.object({
  id: Id,
  cityId: Id,
  areaId: Id,
  name: z.string(),
  category: PoiCategory,
  lat: z.number(),
  lng: z.number(),
  durationMin: DurationRange,
  openingHours: OpeningHours,
  weeklyOff: z.array(Weekday),
  bestTimeOfDay: TimeOfDay,
  /** Windows to avoid (crowds, heat), e.g. [{start:"12:00", end:"15:00"}]. */
  avoidTimes: z.array(TimeWindow),
  interestTags: z.array(z.string()),
  tier: z.enum(["must_see", "worth_it", "niche"]),
  suitability: Suitability,
  accessibility: Accessibility,
  indoorOutdoor: z.enum(["indoor", "outdoor", "mixed"]),
  /** Per adult; 0 if free. */
  priceINR: z.number().nonnegative(),
  bookingRequired: z.boolean(),
  bestMonths: z.array(Month),
  /** How much a guided tour adds (0 = none, 1 = essential). */
  tourValue: Score01,
  /** Set when this POI is visited as a day trip from another city's base. */
  isDayTripFrom: Id.nullable(),
  variants: z.array(PoiVariant).optional(),
  shortDescription: z.string(),
  provenance: Provenance,
  /** Where to stay overnight to avoid a long same-day round trip (far day trips). */
  nearbyStay: z.object({ name: z.string(), note: z.string() }).optional(),
  /** Set on must_see items until a human has checked hours/prices/access. */
  needsVerification: z.boolean().optional(),
});
export type Poi = z.infer<typeof Poi>;

// ---------------------------------------------------------------------------
// Restaurant
// ---------------------------------------------------------------------------

export const MealType = z.enum(["breakfast", "lunch", "dinner", "snack"]);
export type MealType = z.infer<typeof MealType>;

export const Restaurant = z.object({
  id: Id,
  cityId: Id,
  areaId: Id,
  name: z.string(),
  lat: z.number(),
  lng: z.number(),
  cuisine: z.array(z.string()),
  mealTypes: z.array(MealType).min(1),
  priceBand: Tier,
  dietary: z.object({ veg: z.boolean(), jain: z.boolean(), nonVeg: z.boolean() }),
  avgMealMin: z.number().int().positive(),
  seating: z.enum(["table", "counter", "standing", "mixed"]),
  kidFriendly: z.boolean(),
  provenance: Provenance,
});
export type Restaurant = z.infer<typeof Restaurant>;

// ---------------------------------------------------------------------------
// Experience (fixed-schedule, bookable-style activities: tours, workshops)
// ---------------------------------------------------------------------------

export const Experience = z.object({
  id: Id,
  cityId: Id,
  name: z.string(),
  durationMin: z.number().int().positive(),
  startTimes: z.array(TimeHHMM).min(1),
  daysOperating: z.array(Weekday).min(1),
  priceINR: z.number().nonnegative(),
  groupType: z.enum(["private", "small_group", "shared"]),
  includesTransport: z.boolean(),
  suitability: Suitability,
  accessibility: Accessibility,
  linkedPoiIds: z.array(Id),
  interestTags: z.array(z.string()),
  provenance: Provenance,
});
export type Experience = z.infer<typeof Experience>;

// ---------------------------------------------------------------------------
// CityEdge (inter-city travel)
// ---------------------------------------------------------------------------

export const TransportMode = z.enum(["train", "road", "flight"]);
export type TransportMode = z.infer<typeof TransportMode>;

/**
 * Undirected: stored once per (city pair, mode) and applies in both directions.
 * Look up with either order.
 */
export const CityEdge = z.object({
  fromCityId: Id,
  toCityId: Id,
  mode: TransportMode,
  /** Includes getting to/from stations/airports, not just time on board. */
  doorToDoorMin: z.number().int().positive(),
  fareBandINR: z
    .object({ min: z.number().nonnegative(), max: z.number().nonnegative() })
    .refine((f) => f.min <= f.max, "Expected min ≤ max"),
  comfort: z.number().int().min(1).max(5),
  frequencyPerDay: z.number().int().nonnegative(),
  notes: z.string(),
});
export type CityEdge = z.infer<typeof CityEdge>;

// ---------------------------------------------------------------------------
// Event (festivals, closures, crowd spikes)
// ---------------------------------------------------------------------------

export const Event = z.object({
  id: Id,
  name: z.string(),
  cityId: Id,
  startDate: IsoDate,
  endDate: IsoDate,
  /** null = all day. */
  dailyWindow: TimeWindow.nullable(),
  type: z.enum(["festival", "holiday", "closure", "crowd", "weather", "cultural"]),
  impact: z.object({
    level: z.enum(["low", "medium", "high"]),
    kind: z.enum(["crowds", "closure", "traffic", "price_surge", "opportunity"]),
    affectedPoiIds: z.array(Id),
  }),
  /** True when dates are estimated (e.g. lunar calendar, not yet announced). */
  datesApproximate: z.boolean(),
  note: z.string(),
});
export type Event = z.infer<typeof Event>;

// ---------------------------------------------------------------------------
// Constraint
//
// Discriminated on `type` so every constraint's params are typed and the LLM's
// extraction output can be validated strictly (closed list — no invented types).
// ---------------------------------------------------------------------------

export const WeightLevel = z.enum(["low", "medium", "high"]);
export type WeightLevel = z.infer<typeof WeightLevel>;

export const Pace = z.enum(["relaxed", "balanced", "packed"]);
export type Pace = z.infer<typeof Pace>;

export const TravellerProfile = z.enum(["solo", "couple", "friends", "family_kids", "elderly"]);
export type TravellerProfile = z.infer<typeof TravellerProfile>;

/** "trip" | "city:<id>" | "day:<n>" */
export const ConstraintScope = z
  .string()
  .regex(/^(trip|city:[a-z0-9][a-z0-9_-]*|day:[1-9]\d*)$/, "Expected trip | city:<id> | day:<n>");
export type ConstraintScope = z.infer<typeof ConstraintScope>;

const constraintBase = {
  id: z.string(),
  strength: z.enum(["hard", "soft"]),
  weightLevel: WeightLevel,
  scope: ConstraintScope,
  source: z.enum(["form", "chat", "default"]),
  /** The user's words that produced this constraint (for explainability). */
  sourceText: z.string().optional(),
  confidence: Score01,
};

const c = <T extends string, P extends z.ZodType>(type: T, params: P) =>
  z.object({ ...constraintBase, type: z.literal(type), params });

export const Constraint = z.discriminatedUnion("type", [
  c("day_window", z.object({ start: TimeHHMM.optional(), end: TimeHHMM.optional() })),
  c("pace", z.object({ pace: Pace })),
  c("mobility", z.object({ level: z.enum(["full", "short_walks", "step_free"]) })),
  c("traveller_profile", z.object({ profile: TravellerProfile })),
  c("city_include", z.object({ cityId: Id })),
  c("city_exclude", z.object({ cityId: Id })),
  c("city_order", z.object({ cityIds: z.array(Id).min(2) })),
  c("nights_in_city", z.object({
    cityId: Id,
    min: z.number().int().nonnegative().optional(),
    max: z.number().int().nonnegative().optional(),
  })),
  c("date_anchor", z.object({
    date: IsoDate,
    cityId: Id.optional(),
    poiId: Id.optional(),
    note: z.string().optional(),
  })),
  c("poi_include", z.object({ poiId: Id })),
  c("poi_exclude", z.object({ poiId: Id })),
  c("max_transit_per_day", z.object({ minutes: z.number().int().positive() })),
  c("max_walk_km_per_day", z.object({ km: z.number().positive() })),
  c("budget_cap", z.object({
    amountINR: z.number().positive(),
    per: z.enum(["trip", "day", "person_day"]),
  })),
  c("interest_weight", z.object({ tag: z.string(), sentiment: z.enum(["like", "dislike"]) })),
  c("dietary", z.object({ diet: z.enum(["veg", "jain", "non_veg", "any"]) })),
  c("avoid_tag", z.object({ tag: z.string() })),
  // Escape hatch: kept for narration/UI, never drives deterministic logic.
  c("freeform", z.object({ text: z.string() })),
]);
export type Constraint = z.infer<typeof Constraint>;
export type ConstraintType = Constraint["type"];

// ---------------------------------------------------------------------------
// Levers — the knobs the deterministic scheduler actually reads.
// Presets and constraints both resolve down to one Levers object.
// ---------------------------------------------------------------------------

export const Levers = z.object({
  dayStart: TimeHHMM,
  dayEnd: TimeHHMM,
  maxMajorItemsPerDay: z.number().int().positive(),
  /** Slack added between items, as a fraction of scheduled time (0.15 = 15%). */
  bufferPct: z.number().min(0).max(1),
  freeTimeMin: z.number().int().nonnegative(),
  maxWalkKmPerDay: z.number().positive(),
  maxContinuousWalkMin: z.number().int().positive(),
  maxTransitMinPerDay: z.number().int().positive(),
  minNightsPerBase: z.number().int().positive(),
  /** Scales POI typical durations (1.2 = everything takes 20% longer). */
  durationMultiplier: z.number().positive(),
  /** Walks longer than this become a taxi/auto hop. */
  preferTaxiAboveWalkMin: z.number().int().positive(),
  lunchWindow: TimeWindow,
  dinnerWindow: TimeWindow,
  /** When true, meals outside their windows fail validation (elderly/kids need regular meals). */
  mealWindowsHard: z.boolean(),
  /** Latest time to be back at the hotel for the night. */
  returnByLatest: TimeHHMM,
  restBreakEveryMin: z.number().int().positive(),
});
export type Levers = z.infer<typeof Levers>;
export type LeverName = keyof Levers;

export const PresetName = z.enum([
  "default", "relaxed", "balanced", "packed", "late_riser", "early_bird",
  "short_walks", "step_free", "elderly", "family_kids", "foodie",
]);
export type PresetName = z.infer<typeof PresetName>;

/** How to merge a lever when several presets set it ("strictest wins"). */
export const CombineRule = z.enum(["max", "min", "intersect"]);

/** Shape of /data/presets.json. `default` is complete; others override it. */
export const PresetsFile = z.object({
  combine: z.object({
    doc: z.string(),
    rules: z.record(z.string(), CombineRule),
  }),
  presets: z.object({
    default: Levers,
    relaxed: Levers.partial(),
    balanced: Levers.partial(),
    packed: Levers.partial(),
    late_riser: Levers.partial(),
    early_bird: Levers.partial(),
    short_walks: Levers.partial(),
    step_free: Levers.partial(),
    elderly: Levers.partial(),
    family_kids: Levers.partial(),
    foodie: Levers.partial(),
  }),
});
export type PresetsFile = z.infer<typeof PresetsFile>;

/** Shape of /data/weights.json. */
export const WeightsFile = z.record(WeightLevel, Score01);
export type WeightsFile = z.infer<typeof WeightsFile>;

// ---------------------------------------------------------------------------
// Trip input (form + chat, before constraint extraction)
// ---------------------------------------------------------------------------

export const TripInput = z.object({
  /**
   * Places the user named: city IDs, or day-trip POI IDs (e.g. "ajanta-caves"),
   * which the planner turns into their base city + a must-include.
   */
  cityIds: z.array(Id),
  startDate: IsoDate.nullable(),
  days: z.number().int().min(1).max(21),
  travellers: z.object({
    adults: z.number().int().min(1),
    children: z.number().int().nonnegative(),
    seniors: z.number().int().nonnegative(),
  }),
  budgetTier: Tier,
  /** Optional hard cap for the whole trip, INR. */
  budgetCapINR: z.number().positive().nullable(),
  presets: z.array(PresetName),
  interests: z.array(z.string()),
  diet: z.enum(["veg", "jain", "non_veg", "any"]),
  /** Where the trip starts/ends, e.g. arriving at Mumbai airport. */
  arrivalCityId: Id.nullable(),
  /** Free text from the chat box; turned into constraints by the LLM. */
  chatText: z.string(),
});
export type TripInput = z.infer<typeof TripInput>;

// ---------------------------------------------------------------------------
// Plan → legs → days → items
// ---------------------------------------------------------------------------

export const ItemType = z.enum(["activity", "meal", "transfer", "free_time", "rest", "hotel"]);
export type ItemType = z.infer<typeof ItemType>;

export const Item = z.object({
  id: z.string(),
  type: ItemType,
  startTime: TimeHHMM,
  endTime: TimeHHMM,
  /** Catalogue ID (POI / restaurant / experience / area); null for free time, rest. */
  refId: z.string().nullable(),
  title: z.string(),
  /** Locked items survive re-planning untouched. */
  locked: z.boolean(),
  /** Who put it here: the deterministic planner, the AI day-assigner, or the user. */
  source: z.enum(["planner", "ai", "user"]),
  whySelected: z.array(z.string()),
  tradeoffs: z.array(z.string()),
  /** AI-written flavour text; never the source of facts. */
  narration: z.string().nullable(),
  /** Transfer-only details. */
  transfer: z
    .object({
      mode: z.enum(["walk", "auto_taxi", "train", "road", "flight"]),
      distanceKm: z.number().nonnegative(),
    })
    .optional(),
  costINR: z.number().nonnegative().optional(),
});
export type Item = z.infer<typeof Item>;

export const Day = z.object({
  dayNumber: z.number().int().positive(),
  date: IsoDate.nullable(),
  /** Base city for the night. */
  cityId: Id,
  title: z.string().optional(),
  items: z.array(Item),
  totals: z.object({
    walkKm: z.number().nonnegative(),
    transitMin: z.number().nonnegative(),
    costINR: z.number().nonnegative(),
  }),
});
export type Day = z.infer<typeof Day>;

/** One stay at a base city. */
export const Leg = z.object({
  cityId: Id,
  baseAreaId: Id,
  nights: z.number().int().nonnegative(),
  days: z.array(Day),
});
export type Leg = z.infer<typeof Leg>;

// ---------------------------------------------------------------------------
// Trace — every pipeline stage returns one, for debugging and the
// "behind the scenes" view.
// ---------------------------------------------------------------------------

export const TraceDecision = z.object({
  what: z.string(),
  why: z.string(),
  data: z.unknown().optional(),
});
export type TraceDecision = z.infer<typeof TraceDecision>;

export const Trace = z.object({
  stage: z.string(),
  inputs: z.record(z.string(), z.unknown()),
  decisions: z.array(TraceDecision),
  outputs: z.record(z.string(), z.unknown()),
  durationMs: z.number().nonnegative(),
});
export type Trace = z.infer<typeof Trace>;

/** Every planner stage returns its result plus a trace of how it got there. */
export type StageResult<T> = { result: T; trace: Trace };

export const Plan = z.object({
  id: z.string(),
  createdAt: z.string(),
  input: TripInput,
  constraints: z.array(Constraint),
  levers: Levers,
  legs: z.array(Leg),
  warnings: z.array(z.string()),
  traces: z.array(Trace),
});
export type Plan = z.infer<typeof Plan>;
