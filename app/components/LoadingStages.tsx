"use client";

import { Check, Loader2 } from "lucide-react";

/** Stage ids streamed by /api/plan, in order, with what the user sees. */
export const STAGES: { id: string; label: string; detail: string }[] = [
  { id: "understanding", label: "Understanding", detail: "Turning your answers into constraints" },
  { id: "route", label: "Route", detail: "Ordering cities for the least travel" },
  { id: "nights", label: "Nights", detail: "Splitting nights by how much there is to see" },
  { id: "places", label: "Picking places", detail: "Filtering by opening days, access and budget" },
  { id: "scheduling", label: "Scheduling", detail: "Timing each day with meals, rests and travel" },
  { id: "checking", label: "Checking", detail: "Validating hours, walking and transit; repairing" },
  { id: "writing", label: "Writing", detail: "Explaining the plan" },
];

export default function LoadingStages({ current }: { current: string | null }) {
  const idx = current ? STAGES.findIndex((s) => s.id === current) : -1;
  return (
    <div className="mx-auto w-full max-w-md px-4 py-16" role="status" aria-live="polite">
      <h2 className="text-xl font-semibold">Planning your trip…</h2>
      <p className="mt-1 text-sm text-slate-500">Each step below is a real stage of the planner.</p>
      <ol className="mt-6 space-y-3">
        {STAGES.map((s, i) => {
          const done = i < idx;
          const active = i === idx;
          return (
            <li key={s.id} className="flex items-start gap-3">
              <span className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full ${done ? "bg-teal-600 text-white" : active ? "bg-teal-50 text-teal-700 ring-1 ring-teal-600" : "bg-slate-200 text-slate-400"}`}>
                {done ? <Check size={14} /> : active ? <Loader2 size={14} className="animate-spin" /> : <span className="text-xs">{i + 1}</span>}
              </span>
              <span>
                <span className={`block font-medium ${i > idx ? "text-slate-400" : ""}`}>{s.label}</span>
                <span className="block text-sm text-slate-500">{s.detail}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
