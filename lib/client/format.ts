/** Display helpers shared by UI components (no server imports). */
import type { Constraint } from "@/lib/types";

export const WEEKDAY = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
export const SHORT_DATE = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
export const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
export const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
export const minutesBetween = (a: string, b: string) => toMin(b) - toMin(a);
export const hm = (min: number) => (min < 60 ? `${min} min` : `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ""}`);

/** Human label for a constraint chip. */
export function describeConstraint(c: Constraint, names: (id: string) => string): string {
  switch (c.type) {
    case "day_window": return `${c.scope.startsWith("day:") ? `Day ${c.scope.slice(4)}: ` : ""}${c.params.start ? `start ${c.params.start}` : ""}${c.params.end ? ` end ${c.params.end}` : ""}`.trim();
    case "pace": return `${c.scope.startsWith("day:") ? `Day ${c.scope.slice(4)}: ` : ""}${c.params.pace} pace`;
    case "mobility": return { full: "Walks fine, slower", short_walks: "Short walks only", step_free: "Step-free access" }[c.params.level];
    case "traveller_profile": return { solo: "Solo", couple: "Couple", friends: "Friends", family_kids: "Family with kids", elderly: "Elderly travellers" }[c.params.profile];
    case "city_include": return `Include ${names(c.params.cityId)}`;
    case "city_exclude": return `Skip ${names(c.params.cityId)}`;
    case "city_order": return `Order: ${c.params.cityIds.map(names).join(" → ")}`;
    case "nights_in_city": return `${names(c.params.cityId)}: ${c.params.min ?? "?"}–${c.params.max ?? "?"} nights`;
    case "date_anchor": return `${c.params.date}: ${c.params.poiId ? names(c.params.poiId) : c.params.note ?? ""}`;
    case "poi_include": return `Must see ${names(c.params.poiId)}`;
    case "poi_exclude": return `Skip ${names(c.params.poiId)}`;
    case "max_transit_per_day": return `≤ ${c.params.minutes} min travel/day`;
    case "max_walk_km_per_day": return `≤ ${c.params.km} km walking/day`;
    case "budget_cap": return `Budget ≤ ${inr(c.params.amountINR)} per ${c.params.per.replace("_", " ")}`;
    case "interest_weight": return `${c.params.sentiment === "like" ? "Likes" : "Not into"} ${c.params.tag}`;
    case "dietary": return { veg: "Vegetarian", jain: "Jain", non_veg: "Non-veg", any: "Any food" }[c.params.diet];
    case "avoid_tag": return `Avoid ${c.params.tag}`;
    case "freeform": return c.params.text;
  }
}
