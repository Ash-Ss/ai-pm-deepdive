/**
 * Service-layer tests (deterministic, AI off). Run: npm run test:service
 * Checks the API behaviours the UI relies on: day edits leave other days untouched,
 * locks survive, chat edits pick the right scope, chip rejection works.
 */
import { chat, createPlan, regenerateDay, removeItem, swapItem } from "../lib/server/tripService";
import { nextWeekday } from "../lib/planner/time";
import type { Day, Plan, TripInput } from "../lib/types";

process.env.USE_AI = "false";
let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const days = (p: Plan) => p.legs.flatMap((l) => l.days);
const acts = (d: Day) => d.items.filter((i) => i.type === "activity").map((i) => i.refId);
const snapshot = (p: Plan, except: number[]) => JSON.stringify(days(p).filter((d) => !except.includes(d.dayNumber)));

const input: TripInput = {
  cityIds: ["mumbai", "sambhajinagar", "ajanta-caves", "ellora-caves"],
  startDate: nextWeekday(new Date().toISOString().slice(0, 10), "monday"),
  days: 5,
  travellers: { adults: 2, children: 0, seniors: 2 },
  budgetTier: "mid",
  budgetCapINR: null,
  presets: ["relaxed", "late_riser", "short_walks"],
  interests: ["history"],
  diet: "any",
  arrivalCityId: "mumbai",
  chatText: "we like late mornings",
};

async function main() {
  const stages: string[] = [];
  const base = await createPlan(input, [], { onStage: (s) => stages.push(s) });
  check("createPlan reports every stage", stages.join(",") === "understanding,route,nights,places,scheduling,checking,writing", stages.join(","));
  check("free-text box became a chat constraint", base.chatConstraints.some((c) => c.type === "day_window" && c.source === "chat"));
  check("response is plain JSON", JSON.stringify(JSON.parse(JSON.stringify(base))) === JSON.stringify(base));
  check("meta has coordinates for every activity", days(base.plan).every((d) => d.items.filter((i) => i.type === "activity").every((i) => base.meta.places[i.refId!]?.lat)));
  const plan = base.plan;

  // ---- swap
  const d2 = days(plan).find((d) => d.dayNumber === 2)!;
  const target = d2.items.find((i) => i.type === "activity")!;
  const sw = await swapItem(plan, target.id);
  const sd2 = days(sw.plan).find((d) => d.dayNumber === 2)!;
  check("swap replaced the item", !acts(sd2).includes(target.refId) && acts(sd2).length === acts(d2).length, sw.explanation);
  check("swap left other days untouched", snapshot(sw.plan, [2]) === snapshot(plan, [2]));
  check("swap made no LLM call", sw.ai.calls.length === 0);

  // ---- lock + regenerate
  const locked: Plan = JSON.parse(JSON.stringify(plan));
  const keep = days(locked).find((d) => d.dayNumber === 2)!.items.find((i) => i.type === "activity")!;
  keep.locked = true;
  const rg = await regenerateDay(locked, 2, base.chatConstraints);
  const rd2 = days(rg.plan).find((d) => d.dayNumber === 2)!;
  check("regenerate kept the locked item (still locked)", rd2.items.some((i) => i.refId === keep.refId && i.locked));
  check("regenerate changed the other items", acts(rd2).join() !== acts(d2).join(), rg.explanation);
  check("regenerate left other days untouched", snapshot(rg.plan, [2]) === snapshot(locked, [2]));

  // ---- remove
  const rm = await removeItem(plan, target.id);
  check("remove took the item off", !acts(days(rm.plan).find((d) => d.dayNumber === 2)!).includes(target.refId), rm.explanation);
  check("remove stored a soft exclusion", rm.chatConstraints.some((c) => c.type === "poi_exclude" && c.params.poiId === target.refId));
  check("remove left other days untouched", snapshot(rm.plan, [2]) === snapshot(plan, [2]));

  // ---- chat: day-scoped pace
  const c1 = await chat({ message: "make day 2 more relaxed", tripInput: { ...input, chatText: "" }, constraints: base.chatConstraints, plan });
  check("rules path understood 'more relaxed'", c1.constraintOps.some((o) => o.op !== "remove" && o.constraint.type === "pace"), c1.explanation);
  // The rules extractor doesn't know about "day 2"; with AI on the scope would be day:2. Force it to test the path:
  const dayScoped = { ...base.chatConstraints[0], id: "chat-x", type: "pace" as const, params: { pace: "relaxed" as const }, scope: "day:2", sourceText: "make day 2 more relaxed" };
  const c1b = await chat({ ops: [{ op: "add", constraint: dayScoped }], tripInput: { ...input, chatText: "" }, constraints: base.chatConstraints, plan });
  check("day-scoped pace re-plans day 2 only", c1b.changedScope === "day:2" && snapshot(c1b.updated!.plan, [2]) === snapshot(plan, [2]), c1b.explanation);

  // ---- chat: remove a place (days scope, route and nights kept)
  const c2 = await chat({ message: "remove Bibi Ka Maqbara", tripInput: { ...input, chatText: "" }, constraints: base.chatConstraints, plan });
  check("'remove X' → only the day it was on", c2.changedScope === "day:3", c2.changedScope);
  check("…and X is gone", !days(c2.updated!.plan).some((d) => acts(d).includes("bibi-ka-maqbara")), c2.explanation);
  check("…route and nights unchanged", c2.updated!.plan.legs.map((l) => `${l.cityId}${l.nights}`).join() === plan.legs.map((l) => `${l.cityId}${l.nights}`).join());

  // ---- chat: dietary
  const c3 = await chat({ message: "we are vegetarian", tripInput: { ...input, chatText: "" }, constraints: base.chatConstraints, plan });
  const meals = days(c3.updated!.plan).flatMap((d) => d.items.filter((i) => i.type === "meal" && i.refId));
  check("vegetarian → every restaurant serves veg", meals.every((m) => c3.updated!.meta.places[m.refId!]?.dietary?.veg), c3.explanation);
  check("vegetarian keeps every place (re-times only)", days(c3.updated!.plan).every((d) => acts(d).join() === acts(days(plan).find((x) => x.dayNumber === d.dayNumber)!).join()));
  const afterSwap = await chat({ message: "we are vegetarian", tripInput: { ...input, chatText: "" }, constraints: sw.chatConstraints, plan: sw.plan });
  check("…and keeps a swap made just before", acts(days(afterSwap.updated!.plan).find((d) => d.dayNumber === 2)!).join() === acts(sd2).join());
  check("day edits return only their own traces (append)", sw.tracesMode === "append" && sw.traces.length === 1 && sw.traces[0].stage.startsWith("edit:day-2"));
  const c8 = await chat({ message: "skip Lonar", tripInput: { ...input, chatText: "" }, constraints: base.chatConstraints, plan });
  check("excluding a place not in the plan changes nothing", c8.changedScope === "none" && !c8.updated, c8.explanation);

  // ---- chat: city change → full
  const c4 = await chat({ ops: [{ op: "add", constraint: { ...base.chatConstraints[0], id: "chat-y", type: "city_include", params: { cityId: "pune" }, scope: "trip", sourceText: "add Pune" } }], tripInput: { ...input, chatText: "" }, constraints: base.chatConstraints, plan });
  check("adding a city → full re-plan", c4.changedScope === "full" && c4.updated!.plan.legs.some((l) => l.cityId === "pune"), c4.explanation);

  // ---- chip rejection
  check("planner chips are not fed back as user constraints", !base.chatConstraints.some((c) => c.source === "default"));
  for (const c of [c1, c2, c3]) {
    const unchangedDays = days(c.updated!.plan).filter((d) => acts(d).join() === acts(days(plan).find((x) => x.dayNumber === d.dayNumber)!).join()).length;
    check(`"${c.constraintOps.map((o) => (o.op === "remove" ? o.id : o.constraint.sourceText)).join()}" only changes what it should`, unchangedDays >= 4, c.explanation);
  }
  const chip = plan.constraints.find((c) => c.id.startsWith("auto-early-start-day-"));
  if (chip) {
    const c5 = await chat({ ops: [{ op: "remove", id: chip.id }], tripInput: { ...input, chatText: "" }, constraints: base.chatConstraints, plan });
    const n = Number(chip.scope.slice(4));
    const first = days(c5.updated!.plan).find((d) => d.dayNumber === n)!.items[0];
    check(`rejecting ${chip.id} keeps the usual start on day ${n}`, first.startTime >= plan.levers.dayStart, `${first.startTime} ${first.title}`);
    check("…as a day-only change", c5.changedScope === `day:${n}`, c5.changedScope);
  }

  // ---- clarifying question through chat
  const c6 = await chat({ message: "add the fort", tripInput: { ...input, chatText: "" }, constraints: base.chatConstraints, plan });
  check("ambiguous place → question, no change", !!c6.clarifyingQuestion && c6.changedScope === "none", c6.clarifyingQuestion?.options.join(" | "));
  const c7 = await chat({ answer: { question: c6.clarifyingQuestion!, option: c6.clarifyingQuestion!.options[0] }, tripInput: { ...input, chatText: "" }, constraints: base.chatConstraints, plan });
  check("answering adds the place", days(c7.updated!.plan).some((d) => acts(d).includes("daulatabad-fort")), c7.explanation);

  console.log(failures ? `\n✗ ${failures} failure(s)` : "\n✓ all service tests passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
