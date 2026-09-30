/**
 * End-to-end demo of the deterministic planner (no LLM). Run: npm run demo
 *
 * Scenario: Mumbai + Chhatrapati Sambhajinagar (Ajanta/Ellora), 5 days starting
 * next Monday, 2 adults + 2 elderly parents, mid budget, relaxed pace, late
 * starts, short walks.
 */
import { loadCatalogue } from "../lib/catalogue";
import { assignDaysHeuristic } from "../lib/planner/assignDays";
import { runPipeline } from "../lib/planner/pipeline";
import { nextWeekday, weekdayOf } from "../lib/planner/time";
import type { TripInput, Weekday } from "../lib/types";

const today = new Date().toISOString().slice(0, 10);

const scenario = (startDate: string): TripInput => ({
  cityIds: ["mumbai", "sambhajinagar", "ajanta-caves", "ellora-caves"],
  startDate,
  days: 5,
  travellers: { adults: 2, children: 0, seniors: 2 },
  budgetTier: "mid",
  budgetCapINR: null,
  presets: ["relaxed", "late_riser", "short_walks"],
  interests: [],
  diet: "any",
  arrivalCityId: "mumbai",
  chatText: "",
});

const pad = (s: string | number, n: number) => String(s).padEnd(n).slice(0, n);
const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

async function main() {
  const catalogue = loadCatalogue();
  const start = nextWeekday(today, "monday");
  const { plan, validation, debug } = await runPipeline(scenario(start), [], assignDaysHeuristic, catalogue);

  console.log("=".repeat(100));
  console.log("Mumbai + Sambhajinagar (Ajanta/Ellora) · 5 days from", start, "· 2 adults + 2 seniors · mid · relaxed, late starts, short walks");
  console.log("=".repeat(100));

  console.log("\nLEVERS (who set what)");
  for (const p of debug.levers.provenance) {
    if (p.setBy === "default") continue;
    console.log(`  ${pad(p.lever, 24)} ${pad(JSON.stringify(p.value), 36)} ← ${p.setBy}`);
  }

  console.log("\nROUTE");
  for (const r of debug.route.ranked.slice(0, 3)) {
    console.log(`  ${pad(r.order.join(" → "), 30)} score ${r.score}  (transit ${r.breakdown.transitHours}h, backtrack ${r.breakdown.backtrackPenalty}, fatigue ${r.breakdown.fatiguePenalty})`);
  }
  for (const h of debug.route.best.hops) console.log(`  hop: ${h.from} → ${h.to} by ${h.edge.mode}, ${h.minutes} min (alternatives: ${h.alternatives.join(", ") || "none"})`);

  console.log("\nNIGHTS");
  for (const leg of plan.legs) {
    console.log(`  ${pad(leg.cityId, 14)} ${leg.nights} nights · base ${debug.hotels.get(leg.cityId)!.area.name} · demand ${debug.demandDays[leg.cityId]} days`);
  }

  console.log("\nCANDIDATE POOL FUNNEL");
  for (const [city, pool] of debug.pools) {
    console.log(`  ${city}: ${pool.funnel.map((f) => `${f.step} ${f.remaining}`).join(" → ")}`);
    const removed = pool.funnel.flatMap((f) => f.removed).filter((r) => !r.includes("top 40"));
    if (removed.length) console.log(`    removed: ${removed.join(" | ")}`);
  }

  for (const leg of plan.legs) {
    for (const day of leg.days) {
      console.log(`\nDAY ${day.dayNumber} · ${day.date} (${weekdayOf(day.date!)}) · ${day.cityId} · ${day.title}`);
      console.log(`  ${pad("time", 13)} ${pad("type", 10)} ${pad("what", 58)} ${pad("cost", 9)} notes`);
      for (const it of day.items) {
        const notes = [...it.whySelected.slice(0, 2), ...it.tradeoffs].join("; ");
        const extra = it.transfer && it.transfer.distanceKm ? ` ${it.transfer.distanceKm}km` : "";
        console.log(`  ${pad(`${it.startTime}–${it.endTime}`, 13)} ${pad(it.type, 10)} ${pad(it.title + extra, 58)} ${pad(it.costINR ? inr(it.costINR) : "", 9)} ${notes}`);
      }
      console.log(`  totals: walk ${day.totals.walkKm} km · local transit ${day.totals.transitMin} min · ${inr(day.totals.costINR)}`);
    }
  }

  console.log("\nVALIDATION");
  console.log(`  hard violations: ${validation.hard.length}`);
  for (const h of validation.hard) console.log(`    day ${h.dayNumber} ${h.rule}: ${h.detail}`);
  const b = validation.soft.budget;
  console.log(`  budget: est ${inr(b.estimatedINR)} vs mid-tier benchmark ${inr(b.tierBenchmarkINR)} (×${b.ratio})`);
  console.log(`  pace: ${validation.soft.pace.map((p) => `d${p.dayNumber} ${p.majorItems}/${p.maxMajorItems}`).join(", ")}`);

  const repair = plan.traces.find((t) => t.stage === "repairPlan");
  console.log(`\nREPAIRS: ${(repair?.outputs.actions as string[] | undefined)?.join(" | ") || "none needed"}`);
  console.log("\nWARNINGS");
  for (const w of plan.warnings) console.log(`  - ${w}`);

  // ---- weekday safety check across every possible start day
  console.log("\nCLOSURE CHECK (Ajanta closed Monday, Ellora closed Tuesday) across all 7 start weekdays");
  const WEEK: Weekday[] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  let failures = 0;
  for (const wd of WEEK) {
    const s = nextWeekday(today, wd);
    const r = await runPipeline(scenario(s), [], assignDaysHeuristic, catalogue);
    const where = (id: string) =>
      r.plan.legs.flatMap((l) => l.days).filter((d) => d.items.some((i) => i.refId === id)).map((d) => weekdayOf(d.date!));
    const aj = where("ajanta-caves");
    const el = where("ellora-caves");
    const bad = aj.includes("monday") || el.includes("tuesday");
    if (bad) failures++;
    console.log(`  start ${pad(wd, 10)} Ajanta: ${pad(aj.join(",") || "not scheduled", 16)} Ellora: ${pad(el.join(",") || "not scheduled", 16)} hard violations: ${r.validation.hard.length} ${bad ? "✗ FAIL" : "✓"}`);
  }
  console.log(failures ? `\n✗ ${failures} closure failure(s)` : "\n✓ Ajanta never on Monday, Ellora never on Tuesday");
  if (failures) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
