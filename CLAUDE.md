# Trip Planner POC – Maharashtra

## Goal
A working proof-of-concept of an AI-assisted trip PLANNER (no booking, no payments) for Maharashtra, India. The user gives destination(s), days, travellers, budget and preferences in a form + chat. The app produces a day-by-day itinerary the user can edit. It is for a PM assignment demo, so clarity and a working end-to-end flow matter more than scale.

## Core principle
"Software makes it possible, AI makes it personal."
- AI (Gemini) does ONLY: (1) chat → typed constraints, (2) choosing and grouping activities into days from a candidate pool, (3) narration text.
- Deterministic code does everything else: city order, nights allocation, filtering, scheduling, travel times, validation, prices.
- AI must never invent places, times, prices or distances. AI outputs place IDs from a pool the code provides; code validates every ID.

## Stack
- Next.js (App Router) + TypeScript + Tailwind. Single app.
- LLM: Google Gemini via the official @google/genai SDK, server-side only.
- No database: catalogue is JSON in /data; trip state in memory on the client (plus localStorage for the current trip).
- No external APIs other than Gemini. Map optional (Leaflet + free OSM-based tiles, with attribution).

## Secrets
- GEMINI_API_KEY is in .env.local. Read it only in server code (route handlers). Never hardcode, print, log, or expose it to the client. Never use a NEXT_PUBLIC_ prefix for it. Never read or display .env files.
- Model name from env GEMINI_MODEL with a sensible default Flash model.

## LLM usage rules
- All LLM calls go through one wrapper: lib/llm.ts → callLLM({ system, prompt, schema }) returning parsed, schema-validated JSON (use Gemini JSON response mode with a response schema, then validate with zod).
- 1 retry on invalid output, exponential backoff on rate-limit errors.
- Dev cache: hash of (prompt+schema) → cached response in /.cache to save free-tier quota. Toggle with LLM_CACHE=true.
- Keep calls per plan low (target ≤ 4): extract constraints, assign days (whole trip in one call), narrate (whole trip in one call), plus optional edit calls.

## Scope
Cities: Mumbai, Pune, Lonavala, Mahabaleshwar, Chhatrapati Sambhajinagar (Aurangabad; Ajanta & Ellora as day trips).
~80–120 POIs total, ~15–25 restaurants, ~8 experiences.

## Code style
- Small, pure, well-named functions in /lib/planner/*. Each pipeline stage is its own file and returns data plus a "trace" object (inputs, decisions, outputs) for debugging and for a behind-the-scenes view later.
- Types in /lib/types.ts. Zod schemas alongside.
- Prefer simple and readable over clever. Comment the "why".

@AGENTS.md
