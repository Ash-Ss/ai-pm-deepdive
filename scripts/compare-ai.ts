/**
 * Phase 4 follow-up checks. Run: npm run compare:ai
 *  A. Scenario A with USE_AI=false vs USE_AI=true, side by side.
 *  B. "we have elderly parents" → mobility question → how the plan differs per answer.
 * Needs GEMINI_API_KEY for the AI half; set GEMINI_MODEL (e.g. gemini-3.1-flash-lite) to pick the model.
 */
import { loadCatalogue } from "../lib/catalogue";
import { answerQuestion, applyOps } from "../lib/ai/extractConstraints";
import { extractFromChat, planTrip } from "../lib/ai/index";
import { nextWeekday, weekdayOf } from "../lib/planner/time";
import type { Constraint, Plan, TripInput } from "../lib/types";

process.env.LLM_LOG = "false";
const today = new Date().toISOString().slice(0, 10);
const W = 58;
const pad = (s: string, n = W) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
const catalogue = loadCatalogue();

const scenarioA: TripInput = {
  cityIds: ["mumbai", "sambhajinagar", "ajanta-caves", "ellora-caves"],
  startDate: nextWeekday(today, "monday"),
  days: 5,
  travellers: { adults: 2, children: 0, seniors: 2 },
  budgetTier: "mid",
  budgetCapINR: null,
  presets: ["relaxed", "late_riser", "short_walks"],
  interests: ["history", "architecture"],
  diet: "any",
  arrivalCityId: "mumbai",
  chatText: "",
};

const acts = (plan: Plan, dayNumber: number) =>
  plan.legs.flatMap((l) => l.days).find((d) => d.dayNumber === dayNumber)!.items.filter((i) => i.type === "activity").map((i) => i.title.split(" — ")[0]);

/** Word-wrap a string into fixed-width lines. */
function wrap(s: string, n = W): string[] {
  const out: string[] = [];
  let line = "";
  for (const w of s.split(/\s+/)) {
    if ((line + " " + w).trim().length > n) { out.push(line); line = w; } else line = (line + " " + w).trim();
  }
  if (line) out.push(line);
  return out;
}
function sideBySide(left: string[], right: string[]) {
  for (let i = 0; i < Math.max(left.length, right.length); i++) console.log(`  ${pad(left[i] ?? "")} │ ${pad(right[i] ?? "")}`);
}

async function runMode(useAI: boolean) {
  process.env.USE_AI = useAI ? "true" : "false";
  const t0 = Date.now();
  const r = await planTrip(scenarioA, [], { catalogue });
  return { r, ms: Date.now() - t0 };
}

async function main() {
  // ---------------------------------------------------------------- A
  console.log("A. SCENARIO A — Mumbai + Sambhajinagar (Ajanta/Ellora), 5 days, 2 adults + 2 seniors, relaxed, late starts, short walks\n");
  const off = await runMode(false);
  const on = await runMode(true);
  sideBySide([`USE_AI=false`], [`USE_AI=true (${process.env.GEMINI_MODEL || "default model"})`]);
  console.log(`  ${"─".repeat(W)}─┼─${"─".repeat(W)}`);
  const days = off.r.plan.legs.flatMap((l) => l.days);
  for (const d of days) {
    const dOn = on.r.plan.legs.flatMap((l) => l.days).find((x) => x.dayNumber === d.dayNumber)!;
    sideBySide(
      [`Day ${d.dayNumber} ${weekdayOf(d.date!).slice(0, 3)} · ${d.title}`, ...acts(off.r.plan, d.dayNumber).map((a) => `  • ${a}`)],
      [`Day ${d.dayNumber} ${weekdayOf(d.date!).slice(0, 3)} · ${dOn.title}`, ...acts(on.r.plan, d.dayNumber).map((a) => `  • ${a}`)],
    );
    console.log(`  ${" ".repeat(W)} │`);
  }
  const intro = (p: Plan) => p.legs[0].days[0].intro ?? "";
  sideBySide(["Day 1 narration:", ...wrap(intro(off.r.plan))], ["Day 1 narration:", ...wrap(intro(on.r.plan))]);
  console.log(`  ${" ".repeat(W)} │`);
  sideBySide(["Trip summary:", ...wrap(off.r.plan.summary?.trip ?? "")], ["Trip summary:", ...wrap(on.r.plan.summary?.trip ?? "")]);
  console.log(`  ${"─".repeat(W)}─┼─${"─".repeat(W)}`);
  const tokens = on.r.ai.calls.reduce((s, c) => s + c.usage.totalTokens, 0);
  sideBySide(
    [`LLM calls: 0`, `latency: ${off.ms} ms`, `hard violations: ${off.r.validation.hard.length}`, `narration: ${off.r.plan.summary?.source}`],
    [`LLM calls: ${on.r.ai.calls.length} (${on.r.ai.calls.map((c) => `${c.name}${c.cached ? " cached" : ""}`).join(", ")})`,
      `latency: ${on.ms} ms (LLM ${on.r.ai.calls.reduce((s, c) => s + c.ms, 0)} ms, ${tokens} tokens)`,
      `hard violations: ${on.r.validation.hard.length}`, `narration: ${on.r.plan.summary?.source}`],
  );
  console.log("\n  Fallbacks triggered (AI run):", on.r.ai.fallbacks.length ? "" : "none");
  for (const f of on.r.ai.fallbacks) console.log(`   - ${f}`);
  for (const n of on.r.ai.assign?.notes ?? []) console.log(`   - assign: ${n}`);
  for (const x of on.r.ai.narration?.replaced ?? []) console.log(`   - narration replaced (${x.where}): ${x.issues.join("; ")}`);

  // ---------------------------------------------------------------- B
  console.log("\n\nB. MOBILITY QUESTION — chat: \"we have elderly parents\"\n");
  const base: TripInput = { ...scenarioA, presets: [], interests: [], travellers: { adults: 2, children: 0, seniors: 0 } };
  const ctx = { summary: "5 days, Mumbai + Sambhajinagar", cityIds: catalogue.cities.map((c) => c.id), today, tripCityIds: ["mumbai", "sambhajinagar"] };
  const ex = await extractFromChat("we have elderly parents", [], ctx, catalogue);
  console.log(`  extraction (${ex.source}): ${ex.ops.map((o) => (o.op === "remove" ? "remove" : `${o.constraint.type} ${JSON.stringify(o.constraint.params)}`)).join("; ")}`);
  const q = ex.clarifyingQuestion;
  console.log(`  question: ${q ? `${q.text} [${q.options.join(" | ")}]` : "✗ none"}`);
  if (!q) process.exit(1);

  // Elephanta is requested too, to show the "walks fine" exception for a requested high-stairs place.
  const elephanta: Constraint = { id: "chat-99", type: "poi_include", params: { poiId: "elephanta-caves" }, strength: "hard", weightLevel: "high", scope: "trip", source: "chat", sourceText: "must see Elephanta", confidence: 1 };
  process.env.USE_AI = "false"; // deterministic plans, so differences come only from the answer
  const rows: { answer: string; plan: Plan; mult: number; warnings: string[] }[] = [];
  for (const option of q.options) {
    let constraints = applyOps([], ex.ops);
    const op = answerQuestion(q, option, constraints);
    constraints = applyOps(constraints, op ? [op] : []);
    const r = await planTrip(base, [...constraints, elephanta], { catalogue });
    rows.push({ answer: option, plan: r.plan, mult: r.plan.levers.durationMultiplier, warnings: r.plan.warnings });
  }
  for (const row of rows) {
    const lv = row.plan.levers;
    console.log(`\n  ▸ "${row.answer}"`);
    console.log(`    levers: duration ×${lv.durationMultiplier}, max walk ${lv.maxWalkKmPerDay} km/day, rest every ${lv.restBreakEveryMin} min, taxi above ${lv.preferTaxiAboveWalkMin} min walk`);
    for (const d of row.plan.legs.flatMap((l) => l.days)) console.log(`    d${d.dayNumber} ${pad(d.cityId, 13)} ${acts(row.plan, d.dayNumber).join(" · ") || "—"}`);
    const relevant = row.warnings.filter((w) => /Elephanta|Skipped must-see|stairs|asked for/i.test(w));
    for (const w of relevant) console.log(`    ⚠ ${w}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
