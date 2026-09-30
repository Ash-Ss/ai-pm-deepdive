/**
 * Offline tests for the AI layer. A scripted fake transport stands in for
 * Gemini, so every guard (retry, backoff, ID validation, fallbacks, grounding)
 * is exercised deterministically without spending quota. Run: npm run test:ai
 */
import { loadCatalogue } from "../lib/catalogue";
import { ASSIGN_SYSTEM } from "../lib/ai/assignDays";
import { answerQuestion, EXTRACT_SYSTEM, extractConstraintsAI, extractConstraintsRules, MOBILITY_QUESTION } from "../lib/ai/extractConstraints";
import { planTrip } from "../lib/ai/index";
import { droppedNumbers, groundingIssues, NARRATE_SYSTEM, renderTokens } from "../lib/ai/narrate";
import { callLLM, setLLMTransport, type TransportRequest } from "../lib/llm";
import { weekdayOf } from "../lib/planner/time";
import type { TripInput } from "../lib/types";
import { z } from "zod";

process.env.LLM_LOG = "false";
process.env.LLM_CACHE = "false";
const catalogue = loadCatalogue();
let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
};

/** Fake Gemini: per system prompt, a queue of replies (strings, or errors to throw). */
function fake(replies: Record<string, (string | { status: number })[]>) {
  const calls: TransportRequest[] = [];
  setLLMTransport(async (req) => {
    calls.push(req);
    const key = req.system === EXTRACT_SYSTEM ? "extract" : req.system === ASSIGN_SYSTEM ? "assign" : req.system === NARRATE_SYSTEM ? "narrate" : "other";
    const next = replies[key]?.shift();
    if (next === undefined) throw Object.assign(new Error(`no scripted reply for ${key}`), { status: 400 });
    if (typeof next !== "string") throw Object.assign(new Error("scripted error"), next);
    return { text: next, usage: { promptTokens: 100, outputTokens: 50, totalTokens: 150 } };
  });
  return calls;
}

const scenario: TripInput = {
  cityIds: ["mumbai", "sambhajinagar", "ajanta-caves", "ellora-caves"],
  startDate: "2026-10-10", // Saturday → day 3 = Monday (Ajanta closed), day 4 = Tuesday (Ellora closed)
  days: 5,
  travellers: { adults: 2, children: 0, seniors: 2 },
  budgetTier: "mid",
  budgetCapINR: null,
  presets: ["relaxed", "late_riser", "short_walks"],
  interests: [],
  diet: "any",
  arrivalCityId: "mumbai",
  chatText: "",
};

async function main() {
  // ---- 1. callLLM: retry on invalid output, backoff on 429
  console.log("\n# callLLM");
  {
    const calls = fake({ other: [{ status: 429 }, "not json", '{"answer": 42}'] });
    const r = await callLLM({ name: "t", system: "s", prompt: "p", schema: z.object({ answer: z.number() }) });
    check("429 backed off and retried", calls.length === 3);
    check("invalid JSON retried with the error fed back", calls[2].prompt.includes("YOUR PREVIOUS REPLY WAS INVALID"));
    check("valid answer returned", r.data.answer === 42, `attempts=${r.meta.attempts}`);
  }
  {
    fake({ other: ['{"answer": "x"}', '{"answer": "still wrong"}'] });
    const err = await callLLM({ name: "t", system: "s", prompt: "p", schema: z.object({ answer: z.number() }) }).catch((e) => e);
    check("gives up after one retry with invalid_output", err?.kind === "invalid_output");
  }

  // ---- 2. extractConstraints (AI path with a scripted reply)
  console.log("\n# extractConstraints");
  {
    fake({
      extract: [JSON.stringify({
        intent: "add_constraints",
        ops: [
          { op: "add", constraint: { type: "traveller_profile", params: { profile: "elderly" }, strength: "soft", weightLevel: "medium", scope: "trip", sourceText: "my elderly parents", confidence: 0.9 } },
          { op: "add", constraint: { type: "mobility", params: { level: "unknown" }, strength: "soft", weightLevel: "medium", scope: "trip", sourceText: "my elderly parents", confidence: 0.6 } },
          { op: "add", constraint: { type: "city_include", params: { text: "Aurangabad" }, strength: "hard", weightLevel: "high", scope: "trip", sourceText: "Aurangabad", confidence: 0.9 } },
          { op: "add", constraint: { type: "poi_include", params: { text: "Elora" }, strength: "hard", weightLevel: "high", scope: "trip", sourceText: "must see Elora", confidence: 0.9 } },
          { op: "add", constraint: { type: "poi_exclude", params: { text: "Goa beaches" }, strength: "soft", weightLevel: "high", scope: "trip", sourceText: "no Goa beaches", confidence: 0.8 } },
          { op: "add", constraint: { type: "day_window", params: { start: "10:30" }, strength: "soft", weightLevel: "medium", scope: "city:Aurangabad", sourceText: "late start in Aurangabad", confidence: 0.8 } },
        ],
      })],
    });
    const r = await extractConstraintsAI("my elderly parents…", [], { summary: "test", cityIds: catalogue.cities.map((c) => c.id), today: "2026-09-30" }, catalogue);
    const added = r.ops.flatMap((o) => (o.op === "remove" ? [] : [o.constraint]));
    check("Aurangabad resolved to sambhajinagar", added.some((c) => c.type === "city_include" && c.params.cityId === "sambhajinagar"));
    check("typo 'Elora' resolved to ellora-caves", added.some((c) => c.type === "poi_include" && c.params.poiId === "ellora-caves"));
    check("unknown place kept as freeform, not invented", added.some((c) => c.type === "freeform" && c.params.text.includes("Goa")));
    check("scope city:Aurangabad → city:sambhajinagar", added.some((c) => c.type === "day_window" && c.scope === "city:sambhajinagar"));
    check("mobility 'unknown' not stored as a constraint", !added.some((c) => c.type === "mobility"));
    check("standard mobility question asked", JSON.stringify(r.clarifyingQuestion) === JSON.stringify(MOBILITY_QUESTION));
    check("every constraint has a chat id", added.every((c) => c.id.startsWith("chat-") && c.source === "chat"));
  }
  {
    fake({
      extract: [JSON.stringify({
        intent: "add_constraints",
        ops: [{ op: "add", constraint: { type: "mobility", params: { level: "step_free" }, strength: "soft", weightLevel: "medium", scope: "trip", sourceText: "dad uses a wheelchair", confidence: 0.9 } }],
      })],
    });
    const r = await extractConstraintsAI("dad uses a wheelchair", [], { summary: "", cityIds: [], today: "2026-09-30" }, catalogue);
    const c = r.ops[0];
    check("wheelchair forced to hard step_free", c.op === "add" && c.constraint.type === "mobility" && c.constraint.strength === "hard");
  }
  {
    const r = extractConstraintsRules("My elderly parents are coming, we like a late start. Skip Elephanta please.", [], catalogue);
    const added = r.ops.flatMap((o) => (o.op === "remove" ? [] : [o.constraint]));
    check("rules: late start → day_window 10:30", added.some((c) => c.type === "day_window" && c.params.start === "10:30"));
    check("rules: elderly parents → traveller_profile elderly + question", added.some((c) => c.type === "traveller_profile") && !!r.clarifyingQuestion);
    check("rules: skip Elephanta → poi_exclude", added.some((c) => c.type === "poi_exclude" && c.params.poiId === "elephanta-caves"));
  }
  {
    const r = extractConstraintsRules("Please add the fort. Skip Goa.", [], catalogue, ["mumbai", "sambhajinagar"]);
    const q = r.clarifyingQuestions.find((x) => x.kind === "place");
    check("ambiguous 'the fort' → place question with ≤ 3 options", !!q && q.options.length > 1 && q.options.length <= 3, q?.options.join(" | "));
    check("trip-city option listed first", q?.options[0] === "Daulatabad Fort", q?.options[0]);
    check("unknown 'Goa' → user-visible warning", r.warnings.some((w) => w.includes("Goa")));
    const op = q ? answerQuestion(q, q.options[0], []) : null;
    check("answering the place question → poi_include daulatabad-fort", op?.op === "add" && op.constraint.type === "poi_include" && op.constraint.params.poiId === "daulatabad-fort");
    const m = answerQuestion(MOBILITY_QUESTION, "Walks fine, just slower", []);
    check("'walks fine' → mobility full", m?.op === "add" && m.constraint.type === "mobility" && m.constraint.params.level === "full");
  }

  // ---- 3. AI day assignment: bad output → retry → per-day heuristic fallback
  console.log("\n# assignDays (AI) + narration, USE_AI=true with fake Gemini");
  {
    process.env.USE_AI = "true";
    process.env.GEMINI_API_KEY ||= "test-key-not-used";
    const bad = {
      days: [
        { dayIndex: 1, theme: "Harbour", poiIds: ["gateway-of-india", "taj-mahal-palace"], experienceIds: [], whySelected: [{ id: "gateway-of-india", reasons: ["iconic"] }] },
        { dayIndex: 2, theme: "Fort", poiIds: ["csmt", "csmvs-museum"], experienceIds: [], whySelected: [] },
        { dayIndex: 3, theme: "Caves", poiIds: ["ajanta-caves"], experienceIds: [], whySelected: [] },
        { dayIndex: 4, theme: "Ellora", poiIds: ["ellora-caves", "grishneshwar-temple"], experienceIds: [], whySelected: [] },
        { dayIndex: 5, theme: "Old city", poiIds: ["bibi-ka-maqbara"], experienceIds: [], whySelected: [] },
      ],
    };
    const retry = {
      days: [
        { dayIndex: 1, theme: "Harbour evening", poiIds: ["gateway-of-india"], experienceIds: [], whySelected: [{ id: "gateway-of-india", reasons: ["must-see next to the hotel"] }] },
        { dayIndex: 2, theme: "Fort & museum", poiIds: ["csmt", "csmvs-museum"], experienceIds: [], whySelected: [] },
        { dayIndex: 3, theme: "Old city", poiIds: ["panchakki", "bibi-ka-maqbara"], experienceIds: [], whySelected: [] },
        { dayIndex: 4, theme: "Ellora", poiIds: ["ellora-caves"], experienceIds: [], whySelected: [] }, // still closed on Tuesday
        { dayIndex: 5, theme: "Temple", poiIds: ["grishneshwar-temple"], experienceIds: [], whySelected: [] },
      ],
    };
    const narration = {
      tripSummary: "A relaxed trip through {{city:mumbai}} and {{city:sambhajinagar}}, paced for parents who prefer short walks.",
      routeReason: "{{city:mumbai}} first, then a 7 hour hop inland.", // invented number
      days: [
        { dayNumber: 1, intro: "Settle in and stroll to {{poi:gateway-of-india}}." },
        { dayNumber: 2, intro: "A quick detour to {{poi:lonar-crater}}." }, // token for a place not in the plan
        { dayNumber: 3, intro: "Visit Bibi Ka Maqbara in the afternoon." }, // name typed out instead of a token
      ],
      items: [],
      tradeoffs: [],
    };
    const calls = fake({ assign: [JSON.stringify(bad), JSON.stringify(retry)], narrate: [JSON.stringify(narration)] });
    const r = await planTrip(scenario, []);
    const days = r.plan.legs.flatMap((l) => l.days);
    const where = (id: string) => days.filter((d) => d.items.some((i) => i.refId === id)).map((d) => weekdayOf(d.date!));
    check("assign retried once with the errors", calls.filter((c) => c.system === ASSIGN_SYSTEM).length === 2 && calls[1].prompt.includes("taj-mahal-palace is not in the mumbai pool"));
    check("invented id never reaches the plan", !days.some((d) => d.items.some((i) => i.refId === "taj-mahal-palace")));
    check("failed day 4 fell back to the heuristic", JSON.stringify(r.ai.assign?.fallbackDays) === "[4]", `notes: ${r.ai.assign?.notes.at(-1)}`);
    check("Ajanta never on Monday", !where("ajanta-caves").includes("monday"), `Ajanta: ${where("ajanta-caves").join(",") || "none"}`);
    check("Ellora never on Tuesday", !where("ellora-caves").includes("tuesday"), `Ellora: ${where("ellora-caves").join(",") || "none"}`);
    check("AI themes used for AI days", days[0].title === "Harbour evening");
    check("0 hard violations", r.validation.hard.length === 0, r.validation.hard.map((h) => h.detail).join("; "));
    check("grounded summary kept, tokens rendered to names", r.plan.summary?.trip === "A relaxed trip through Mumbai and Chhatrapati Sambhajinagar (Aurangabad), paced for parents who prefer short walks.", r.plan.summary?.trip);
    check("token rendered in day 1 intro", days[0].intro === "Settle in and stroll to Gateway of India.", days[0].intro);
    check("typed-out name (no token) replaced by template", days[2].intro !== narration.days[2].intro && r.ai.narration!.replaced.some((x) => x.where === "day 3 intro"));
    check("ungrounded route reason replaced by template", r.plan.summary?.route !== narration.routeReason && r.ai.narration!.replaced.some((x) => x.where === "routeReason"));
    check("invented place in day intro replaced", days[1].intro !== narration.days[1].intro);
    check("≤ 4 LLM calls for the plan", r.ai.calls.length <= 4, `${r.ai.calls.length} calls`);
  }

  // ---- 4. Gemini down → everything still works
  console.log("\n# Gemini unavailable");
  {
    fake({}); // every call throws
    const r = await planTrip(scenario, []);
    check("heuristic used when assignment call fails", r.ai.assign?.fullFallback === true);
    check("templates used when narration fails", r.plan.summary?.source === "template");
    check("plan still valid", r.validation.hard.length === 0);
  }

  // ---- 5. USE_AI=false
  console.log("\n# USE_AI=false");
  {
    process.env.USE_AI = "false";
    const calls = fake({});
    const r = await planTrip(scenario, []);
    check("no LLM calls at all", calls.length === 0);
    check("template narration present", !!r.plan.summary?.trip && r.plan.summary.source === "template");
  }

  // ---- 6. grounding unit checks
  console.log("\n# grounding");
  const entities = new Map([["{{poi:ajanta-caves}}", { token: "{{poi:ajanta-caves}}", kind: "poi" as const, id: "ajanta-caves", name: "Ajanta Caves" }]]);
  const g = { factNumbers: new Set(["08:30", "4700", "4,700", "2"]), entities, allowedCaps: new Set(["leave", "a", "it", "then", "enjoy", "mumbai"]) };
  check("time 8:30 matches 08:30", groundingIssues("Leave at 8:30 for {{poi:ajanta-caves}}.", g).length === 0);
  check("₹4,700 matches", groundingIssues("A car costs about ₹4,700.", g).length === 0);
  check("invented number caught", groundingIssues("It takes 6 hours.", g).length === 1);
  check("unknown token caught", groundingIssues("Then visit {{poi:lonar-crater}}.", g).some((i) => i.includes("not in this plan")));
  check("typed-out name caught", groundingIssues("Then visit Lonar Crater.", g).length === 2);
  check("common sentence starter allowed", groundingIssues("Enjoy {{poi:ajanta-caves}} at sunset.", g).length === 0);
  check("city names from data allowed", groundingIssues("Then Mumbai.", g).length === 0);
  check("malformed token caught", groundingIssues("Enjoy {{poi:ajanta-caves}.", g).length > 0);
  check("render replaces tokens", renderTokens("Enjoy {{poi:ajanta-caves}}.", entities) === "Enjoy Ajanta Caves.");
  check("rewrite that drops a time is caught", droppedNumbers("Starts at 08:30 instead of 10:30", "We start a little earlier today").length === 2);
  check("numbers inside names may be dropped", droppedNumbers('Doing "Ajanta – highlights (Caves 1, 2, 16)"', "We focus on the highlights").length === 0);
  check("rewrite that keeps times passes", droppedNumbers("Starts at 08:30 instead of 10:30", "An earlier 8:30 start (not 10:30) keeps lunch on time").length === 0);

  setLLMTransport(null);
  console.log(failures ? `\n✗ ${failures} failure(s)` : "\n✓ all AI-layer tests passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
