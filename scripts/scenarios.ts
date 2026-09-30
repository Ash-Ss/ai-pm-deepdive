/**
 * End-to-end scenarios with assertions. Run: npm run scenarios
 * Works with AI off (heuristic + templates) or on (USE_AI=true); with
 * DEMO_RECORD=true and AI on, successful Gemini answers are saved to the demo cache.
 *
 *  A  Mumbai + Chhatrapati Sambhajinagar, 5 days from next Monday, couple + 2 elderly parents,
 *     mid, relaxed, "we like waking up late, my parents can only do short walks"
 *  B  Pune + Lonavala + Mahabaleshwar, 4 days, couple, balanced, food + nature + photography
 *  C  Chat on B: "make day 2 more relaxed" → only day 2 changes
 */
import { loadCatalogue } from "../lib/catalogue";
import { DEMO_SCENARIOS } from "../lib/demoScenarios";
import { toMin, weekdayOf } from "../lib/planner/time";
import { chat, createPlan, type PlanResponse } from "../lib/server/tripService";
import type { Day } from "../lib/types";

process.env.LLM_LOG ??= "false";
const catalogue = loadCatalogue();
let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const days = (r: PlanResponse) => r.plan.legs.flatMap((l) => l.days);
const activities = (d: Day) => d.items.filter((i) => i.type === "activity");
const poiOf = (id: string | null) => catalogue.pois.find((p) => p.id === id);

function show(r: PlanResponse) {
  for (const d of days(r)) {
    console.log(`    d${d.dayNumber} ${weekdayOf(d.date!).slice(0, 3)} ${d.cityId.padEnd(13)} ${activities(d).map((a) => `${a.startTime} ${a.title.split(" — ")[0]}`).join(" · ") || "—"}`);
  }
  console.log(`    AI ${r.ai.enabled ? "on" : "off"} · ${r.ai.calls.length} LLM call(s)${r.ai.calls.some((c) => c.demo) ? ` (${r.ai.calls.filter((c) => c.demo).length} from demo cache)` : ""}${r.ai.fallbacks.length ? ` · fallbacks: ${r.ai.fallbacks.join("; ")}` : ""}`);
}

const SCENARIOS = { A: DEMO_SCENARIOS.A.input(), B: DEMO_SCENARIOS.B.input() };

async function main() {
  // ---------------------------------------------------------------- A
  console.log("\nA · Mumbai + Chhatrapati Sambhajinagar, 5 days, couple + 2 elderly parents, relaxed, late starts, short walks");
  const a = await createPlan(SCENARIOS.A, []);
  show(a);
  const late = a.chatConstraints.find((c) => c.type === "day_window");
  check("'waking up late' understood as day_window 10:30", late?.type === "day_window" && late.params.start === "10:30", JSON.stringify(late?.params));
  check("'short walks' understood as mobility short_walks", a.chatConstraints.some((c) => c.type === "mobility" && c.params.level === "short_walks"));
  const early = days(a).flatMap((d) => activities(d).filter((i) => toMin(i.startTime) < toMin("10:30")).map((i) => `d${d.dayNumber} ${i.startTime} ${i.title}`));
  check("no activity before 10:30", early.length === 0, early.join("; "));
  const where = (id: string) => days(a).filter((d) => activities(d).some((i) => i.refId === id)).map((d) => weekdayOf(d.date!));
  check("Ajanta not on Monday", !where("ajanta-caves").includes("monday"), `Ajanta: ${where("ajanta-caves").join(",") || "not scheduled"}`);
  check("Ellora not on Tuesday", !where("ellora-caves").includes("tuesday"), `Ellora: ${where("ellora-caves").join(",") || "not scheduled"}`);
  const highStairs = days(a).flatMap((d) => activities(d).filter((i) => {
    const p = poiOf(i.refId);
    if (p?.accessibility.stairsLevel !== "high") return false;
    // A lighter variant shows up in the title ("Daulatabad Fort — lower fort & Chand Minar").
    return !(p.variants ?? []).some((v) => i.title.includes(v.name.replace(/^.*?–\s*/, "")));
  }).map((i) => i.title));
  check("no high-stairs place unless a lighter variant is used", highStairs.length === 0, highStairs.join("; "));
  const overWalk = days(a).filter((d) => d.totals.walkKm > a.plan.levers.maxWalkKmPerDay).map((d) => `d${d.dayNumber} ${d.totals.walkKm} km`);
  check(`walking ≤ ${a.plan.levers.maxWalkKmPerDay} km every day`, overWalk.length === 0, overWalk.join("; "));
  check("no hard violations", a.validation.hard.length === 0, a.validation.hard.map((h) => h.detail).join("; "));

  // ---------------------------------------------------------------- B
  console.log("\nB · Pune + Lonavala + Mahabaleshwar, 4 days, couple, balanced, food + nature + photography");
  const b = await createPlan(SCENARIOS.B, []);
  show(b);
  const order = b.plan.legs.map((l) => l.cityId);
  check("route: Lonavala next to Pune", Math.abs(order.indexOf("lonavala") - order.indexOf("pune")) === 1, order.join(" → "));
  const sunsets = days(b).flatMap((d) => activities(d).filter((i) => poiOf(i.refId)?.bestTimeOfDay === "sunset").map((i) => ({ d: d.dayNumber, i })));
  const notEvening = sunsets.filter(({ i }) => Math.min(toMin(i.endTime), toMin("19:30")) - Math.max(toMin(i.startTime), toMin("17:00")) < 15);
  check("sunset viewpoints are scheduled in the evening", notEvening.length === 0,
    `${sunsets.map(({ d, i }) => `d${d} ${i.startTime}–${i.endTime} ${i.title}`).join("; ") || "no sunset spots scheduled"}`);
  check("no hard violations", b.validation.hard.length === 0, b.validation.hard.map((h) => h.detail).join("; "));

  // ---------------------------------------------------------------- C
  console.log("\nC · Chat on B: \"make day 2 more relaxed\"");
  const c = await chat({ message: "make day 2 more relaxed", tripInput: { ...SCENARIOS.B, chatText: "" }, constraints: b.chatConstraints, plan: b.plan });
  console.log(`    ${c.explanation}`);
  if (c.updated) show(c.updated);
  check("change scoped to day 2", c.changedScope === "day:2", c.changedScope);
  const after = c.updated ? days(c.updated) : [];
  const changedOthers = days(b).filter((d) => d.dayNumber !== 2 && JSON.stringify(d) !== JSON.stringify(after.find((x) => x.dayNumber === d.dayNumber)));
  check("every other day identical", !!c.updated && changedOthers.length === 0, changedOthers.map((d) => `day ${d.dayNumber} changed`).join("; "));
  const d2Before = activities(days(b).find((d) => d.dayNumber === 2)!).length;
  const d2After = after.length ? activities(after.find((d) => d.dayNumber === 2)!).length : -1;
  check("day 2 is no busier than before, and within the relaxed limit (3)", d2After >= 0 && d2After <= Math.min(d2Before, 3), `${d2Before} → ${d2After} sights`);

  console.log(failures ? `\n✗ ${failures} failure(s)` : "\n✓ all scenarios passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
