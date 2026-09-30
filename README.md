# Maharashtra Trip Planner (POC)

An AI-assisted **trip planner** (no booking, no payments) for Mumbai, Pune, Lonavala, Mahabaleshwar and
Chhatrapati Sambhajinagar (with Ajanta & Ellora as day trips). You fill a short form and chat; it builds a
day-by-day itinerary with real opening days, travel times, meals and rest — and explains every choice.

> **Software makes it possible, AI makes it personal.** Code does the facts; Gemini does the understanding,
> the choosing within a code-approved list, and the words.

## Run it

```bash
npm install
cp .env.example .env.local        # add GEMINI_API_KEY if you want the AI layer
npm run dev                       # http://localhost:3000
```

Works without a key: with `USE_AI` unset the app uses the deterministic planner, rule-based chat and
template narration. On the start screen, **Try a demo** fills in one of the two demo scenarios.

**For a live demo** (resilient to rate limits and no network to Gemini):

```bash
USE_AI=true DEMO_CACHE=true GEMINI_MODEL=gemini-3.1-flash-lite npm run dev
```

If a Gemini call fails, recorded answers for the demo scenarios are served from `data/demo-cache/`
(they still go through every validation and grounding check). Re-record after changing the planner:
`USE_AI=true DEMO_RECORD=true npm run scenarios`.

## Environment variables

| Variable | Default | What it does |
|---|---|---|
| `GEMINI_API_KEY` | – | Gemini key. Read only in server code (`lib/llm.ts`); never sent to the browser or logged. |
| `GEMINI_MODEL` | `gemini-flash-latest` | Any Gemini model id. `gemini-3.1-flash-lite` is fast and has a friendlier free quota. |
| `GEMINI_THINKING_LEVEL` | – | `LOW` etc. for Gemini 3 models: faster, cheaper calls. |
| `USE_AI` | off | `true` turns on Gemini for chat understanding, day assignment and narration. |
| `LLM_CACHE` | off | `true` caches LLM answers in `/.cache` by prompt hash (saves quota while developing). |
| `DEMO_CACHE` | off | `true` serves recorded answers from `data/demo-cache` when a live call fails (works without a key). |
| `DEMO_RECORD` | off | `true` saves successful live answers into `data/demo-cache`. |

## Tests and scripts

| Command | What it checks |
|---|---|
| `npm test` | Everything below that runs offline (data, AI layer with a fake Gemini, service, scenarios). |
| `npm run scenarios` | 3 end-to-end scenarios with assertions (see below). Add `USE_AI=true` to run with Gemini. |
| `npm run test:ai` | LLM wrapper retries/backoff, ID guarding, fallbacks, grounding — with a scripted fake Gemini. |
| `npm run test:service` | API behaviours: day edits leave other days untouched, locks survive, chat scopes, chip rejection. |
| `npm run validate:data` | Catalogue integrity: ids, references, opening hours, coordinates, coverage. |
| `npm run demo` / `demo:ai` / `compare:ai` | Printed walkthroughs (planner only / live AI / AI off vs on). |

Scenarios: **A** Mumbai + Sambhajinagar, 5 days, couple + 2 elderly parents, "we like waking up late, my
parents can only do short walks" → no sight before 10:30, Ajanta never Monday, Ellora never Tuesday, no
high-stairs places without a lighter variant, walking limit respected. **B** Pune + Lonavala + Mahabaleshwar,
4 days → Lonavala next to Pune in the route, sunset viewpoints in the evening. **C** "make day 2 more
relaxed" on B → only day 2 changes.

## Architecture

```
 Browser (Next.js client, localStorage)                 Server (route handlers, Node)
 ┌──────────────────────────────┐   POST /api/plan (NDJSON stages)   ┌─────────────────────────────────┐
 │ Start form → Loading stages  │ ─────────────────────────────────▶ │ lib/server/tripService.ts        │
 │ Plan view: chips, route,     │   POST /api/chat                   │  createPlan · chat · swap ·      │
 │ day cards, map, warnings,    │   POST /api/regenerate-day         │  removeItem · regenerateDay      │
 │ behind-the-scenes traces     │   POST /api/swap · /api/remove     │  (picks the smallest re-plan)    │
 │ Chat panel (quick replies)   │ ◀───────────────────────────────── │                                 │
 └──────────────────────────────┘        JSON (plan + meta)          └───────────────┬─────────────────┘
                                                                                     │
      ┌──────────────────────────────── lib/ai (Gemini, optional) ───────────────────┼──────────────┐
      │ extractConstraints: chat → typed constraint ops (places as text)             │              │
      │ assignDays:        pick + group pool IDs into days                           │  lib/llm.ts  │
      │ narrate:           friendly text using {{poi:ID}} tokens                     │  one wrapper:│
      │ fallbacks:         rules · heuristic · templates                             │  schema, zod,│
      └──────────────────────────────────────────────────────────────────────────────┤  retry,      │
                                                                                     │  backoff,    │
      ┌──────────────────────── lib/planner (deterministic, traced) ─────────────────┤  caches      │
      │ constraints ← form + chat                                                    └──────────────┘
      │ resolveLevers → routeOrder → allocateNights → candidatePool → baseArea
      │ → dayFrames → [assign: AI or heuristic] → sanitizeAssignment (ID guard)
      │ → scheduleDay (per day, all orderings) → validatePlan → repairPlan → Plan
      └── data/*.json catalogue: cities, areas, POIs, restaurants, experiences, edges, events, presets
```

Every planner stage returns `{ result, trace }`; traces power the **Behind the scenes** panel.

### What is AI vs code

| AI (Gemini) | Code (deterministic) |
|---|---|
| Understand chat → typed constraints ("wake up late" → start 10:30) | Place-name resolution, IDs, validation of every constraint |
| Choose and group activities into days, from a code-built candidate pool | Route order, nights, filtering (hours, access, budget), scheduling, travel times, meals, prices |
| Write narration (summary, day intros, "why this", kinder tradeoff notes) | Grounding check: only known entity tokens, numbers from the facts, else a template |
| — | Validation (closures, overlaps, walking, transit, meals, return time) and repair |

The AI never produces a place, time, price or distance that code hasn't supplied: assignments are
checked ID by ID, and narration refers to places only through tokens that code renders.

## Known limitations

- **Travel times are estimates**: straight-line distance × a road factor ÷ typical city speeds; inter-city
  door-to-door times are hand-set bands. No live traffic.
- **Curated, AI-drafted data**: ~80 places, 35 restaurants, 8 experiences. Opening hours, prices and
  accessibility are drafts (confidence 0.6, shown as "estimated"); must-sees are flagged for verification.
  Some Sambhajinagar restaurants are labelled placeholders.
- **No live prices or availability**: costs are planner estimates (with their basis shown); flights and
  trains are assumed times, not bookings.
- **Small area**: five cities only; events (festivals) are approximate.
- **Chat without AI** understands common phrases only, and the chat edits plans rather than answering questions.
- **Map tiles** come from OpenStreetMap and need internet access in the browser.
