/**
 * Live end-to-end demo with Gemini: chat → constraints → plan (AI assignment)
 * → narration. Run: npm run demo:ai   (needs GEMINI_API_KEY; set LLM_CACHE=true to reuse answers)
 * With USE_AI=false it runs the same flow on rules + heuristic + templates.
 */
import { loadCatalogue } from "../lib/catalogue";
import { applyOps } from "../lib/ai/extractConstraints";
import { extractFromChat, planTrip } from "../lib/ai/index";
import { isAIEnabled } from "../lib/llm";
import { nextWeekday, weekdayOf } from "../lib/planner/time";
import type { Constraint, TripInput } from "../lib/types";

process.env.USE_AI ??= "true";

const today = new Date().toISOString().slice(0, 10);
const pad = (s: string | number, n: number) => String(s).padEnd(n).slice(0, n);

async function main() {
  const catalogue = loadCatalogue();
  console.log(`AI ${isAIEnabled() ? "ON" : "OFF (rules + heuristic + templates)"}\n`);

  // The form gives the basics; the chat adds the personal bits.
  const input: TripInput = {
    cityIds: ["mumbai", "sambhajinagar"],
    startDate: nextWeekday(today, "monday"),
    days: 5,
    travellers: { adults: 2, children: 0, seniors: 2 },
    budgetTier: "mid",
    budgetCapINR: null,
    presets: [],
    interests: [],
    diet: "any",
    arrivalCityId: "mumbai",
    chatText: "",
  };
  const message =
    "We're travelling with my elderly parents and we like a relaxed pace and to wake up late. " +
    "Must see Ajanta and Elora. Skip Elephanta. We love history and architecture.";

  console.log(`CHAT: "${message}"`);
  const context = { summary: `${input.days} days, ${input.cityIds.join(" + ")}, 2 adults + 2 seniors, mid budget`, cityIds: catalogue.cities.map((c) => c.id), today };
  let constraints: Constraint[] = [];
  const ex = await extractFromChat(message, constraints, context, catalogue);
  console.log(`intent: ${ex.intent} (source: ${ex.source}${ex.fallback ? `; ${ex.fallback}` : ""})`);
  for (const op of ex.ops) {
    if (op.op === "remove") console.log(`  - remove ${op.id}`);
    else console.log(`  ${op.op} ${op.constraint.id}: ${op.constraint.type} ${JSON.stringify(op.constraint.params)} [${op.constraint.strength}, ${op.constraint.weightLevel}, ${op.constraint.scope}] ← "${op.constraint.sourceText}"`);
  }
  for (const n of ex.notes) console.log(`  note: ${n}`);
  constraints = applyOps(constraints, ex.ops);

  if (ex.clarifyingQuestion) {
    const answer = ex.clarifyingQuestion.options[1] ?? ex.clarifyingQuestion.options[0];
    console.log(`QUESTION: ${ex.clarifyingQuestion.text} [${ex.clarifyingQuestion.options.join(" | ")}] → answering "${answer}"`);
    // The answer goes back through the same extractor, like any chat message.
    const ans = await extractFromChat(answer, constraints, context, catalogue);
    for (const op of ans.ops) if (op.op !== "remove") console.log(`  ${op.op} ${op.constraint.id}: ${op.constraint.type} ${JSON.stringify(op.constraint.params)} [${op.constraint.strength}]`);
    constraints = applyOps(constraints, ans.ops);
  }

  const r = await planTrip(input, constraints, { catalogue });
  console.log(`\n${"=".repeat(100)}\n${r.plan.summary?.trip}\n${r.plan.summary?.route}\n(narration source: ${r.plan.summary?.source})\n${"=".repeat(100)}`);

  for (const day of r.plan.legs.flatMap((l) => l.days)) {
    console.log(`\nDAY ${day.dayNumber} · ${day.date} (${weekdayOf(day.date!)}) · ${day.cityId} · ${day.title}`);
    if (day.intro) console.log(`  ${day.intro}`);
    for (const it of day.items) {
      if (it.type === "transfer" && it.transfer?.mode !== "flight" && !it.assumed && !it.tradeoffs.length) continue; // keep the table readable
      console.log(`  ${pad(`${it.startTime}–${it.endTime}`, 13)} ${pad(it.type, 9)} ${pad(it.title, 70)} ${it.costINR ? `est. ₹${it.costINR.toLocaleString("en-IN")}` : ""}`);
      if (it.narration) console.log(`  ${" ".repeat(24)}↳ ${it.narration}`);
      for (const tr of it.tradeoffs) console.log(`  ${" ".repeat(24)}⚖ ${tr}`);
    }
  }

  console.log(`\nVALIDATION: ${r.validation.hard.length} hard violations`);
  for (const h of r.validation.hard) console.log(`  day ${h.dayNumber} ${h.rule}: ${h.detail}`);
  console.log("\nWARNINGS");
  for (const w of r.plan.warnings) console.log(`  - ${w}`);

  console.log("\nAI REPORT");
  const calls = [...(ex.llm ? [ex.llm] : []), ...r.ai.calls];
  for (const c of calls) console.log(`  ${pad(c.name, 18)} ${c.cached ? "cache hit" : `${c.attempts} attempt(s)`} ${c.ms} ms · tokens in ${c.usage.promptTokens} / out ${c.usage.outputTokens}`);
  console.log(`  LLM calls for this plan: ${r.ai.calls.length} (+ ${calls.length - r.ai.calls.length} for chat extraction)`);
  for (const f of r.ai.fallbacks) console.log(`  fallback: ${f}`);
  for (const n of r.ai.assign?.notes ?? []) console.log(`  assign: ${n}`);
  for (const x of r.ai.narration?.replaced ?? []) console.log(`  narration replaced (${x.where}): ${x.issues.join("; ")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
