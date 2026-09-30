/**
 * The demo scenarios, shared by scripts/scenarios.ts and the start form's "Try a demo" buttons.
 * Keeping the inputs identical means demo mode (DEMO_CACHE=true) can serve recorded Gemini
 * answers for them. Dates are always "next Monday", so weekday-dependent closures line up.
 */
import { nextWeekday } from "./planner/time";
import type { TripInput } from "./types";

const nextMonday = () => nextWeekday(new Date().toISOString().slice(0, 10), "monday");

export const DEMO_SCENARIOS: Record<"A" | "B", { label: string; input: () => TripInput }> = {
  A: {
    label: "Mumbai + Ajanta/Ellora with elderly parents",
    input: () => ({
      cityIds: ["mumbai", "sambhajinagar", "ajanta-caves", "ellora-caves"],
      startDate: nextMonday(),
      days: 5,
      travellers: { adults: 2, children: 0, seniors: 2 },
      budgetTier: "mid",
      budgetCapINR: null,
      presets: ["relaxed"],
      interests: [],
      diet: "any",
      arrivalCityId: "mumbai",
      chatText: "we like waking up late, my parents can only do short walks",
    }),
  },
  B: {
    label: "Pune, Lonavala & Mahabaleshwar for a couple",
    input: () => ({
      cityIds: ["pune", "lonavala", "mahabaleshwar"],
      startDate: nextMonday(),
      days: 4,
      travellers: { adults: 2, children: 0, seniors: 0 },
      budgetTier: "mid",
      budgetCapINR: null,
      presets: ["balanced"],
      interests: ["food", "nature", "photography"],
      diet: "any",
      arrivalCityId: "pune",
      chatText: "",
    }),
  },
};
