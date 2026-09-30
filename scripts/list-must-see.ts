/**
 * Prints every must_see POI with hours and weekly off, as a checklist for
 * manual verification. Run: npm run list:must-see
 */
import { z } from "zod";
import poisJson from "../data/pois.json";
import { Poi, type Weekday } from "../lib/types";

const pois = z.array(Poi).parse(poisJson);

const DAYS: Weekday[] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const short = (d: string) => d.slice(0, 3).replace(/^./, (c) => c.toUpperCase());

/** Collapse identical per-day hours into one line, e.g. "Tue–Sun 09:00–17:30". */
function describeHours(p: Poi): string {
  const fmt = (d: Weekday) => p.openingHours[d].map(([o, c]) => `${o}–${c}`).join(", ");
  const open = DAYS.filter((d) => p.openingHours[d].length > 0);
  const distinct = new Set(open.map(fmt));
  if (distinct.size === 1) {
    const h = fmt(open[0]);
    if (h === "00:00–23:59") return "open 24h";
    return open.length === 7 ? `daily ${h}` : `${open.map(short).join("/")} ${h}`;
  }
  return open.map((d) => `${short(d)} ${fmt(d)}`).join("; ");
}

let city = "";
for (const p of pois.filter((x) => x.tier === "must_see")) {
  if (p.cityId !== city) {
    city = p.cityId;
    console.log(`\n## ${city}`);
  }
  const off = p.weeklyOff.length ? p.weeklyOff.map(short).join(", ") : "none";
  console.log(`- ${p.name} [${p.id}] | ${describeHours(p)} | off: ${off} | ₹${p.priceINR} | stairs: ${p.accessibility.stairsLevel}`);
}
