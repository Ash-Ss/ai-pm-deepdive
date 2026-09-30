"use client";

import { CalendarDays, MapPin, Minus, Plus, Sparkles, Users, Wallet } from "lucide-react";
import { useState } from "react";
import type { PresetName, TripInput } from "@/lib/types";

export const CITIES = [
  { id: "mumbai", name: "Mumbai", blurb: "Harbour, colonial Fort, sea-face" },
  { id: "pune", name: "Pune", blurb: "Peshwa heritage, food, gardens" },
  { id: "lonavala", name: "Lonavala", blurb: "Caves, forts, monsoon valleys" },
  { id: "mahabaleshwar", name: "Mahabaleshwar", blurb: "Hill views, lakes, strawberries" },
  { id: "sambhajinagar", name: "Chhatrapati Sambhajinagar", blurb: "Ajanta & Ellora, Mughal monuments" },
];
const DAY_TRIPS = [
  { id: "ajanta-caves", name: "Ajanta Caves (full day)" },
  { id: "ellora-caves", name: "Ellora Caves" },
];
const INTERESTS = ["history", "food", "nature", "spiritual", "shopping", "nightlife", "photography"];
const PACES: { id: "relaxed" | "balanced" | "packed"; label: string; hint: string }[] = [
  { id: "relaxed", label: "Relaxed", hint: "3 sights a day, long breaks" },
  { id: "balanced", label: "Balanced", hint: "4 sights a day" },
  { id: "packed", label: "Packed", hint: "See as much as possible" },
];
const TIERS = [
  { id: "budget", label: "Budget" },
  { id: "mid", label: "Mid-range" },
  { id: "premium", label: "Premium" },
] as const;

export function nextMonday(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + (((8 - d.getUTCDay()) % 7) || 7));
  return d.toISOString().slice(0, 10);
}

export function defaultTripInput(): TripInput {
  return {
    cityIds: ["mumbai", "sambhajinagar", "ajanta-caves", "ellora-caves"],
    startDate: nextMonday(),
    days: 5,
    travellers: { adults: 2, children: 0, seniors: 2 },
    budgetTier: "mid",
    budgetCapINR: null,
    presets: ["relaxed"],
    interests: ["history"],
    diet: "any",
    arrivalCityId: "mumbai",
    chatText: "We like late mornings and short walks.",
  };
}

function Stepper({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-3 py-2">
      <span className="text-sm text-slate-700">{label}</span>
      <div className="flex items-center gap-2">
        <button type="button" aria-label={`Fewer ${label}`} disabled={value <= min} onClick={() => onChange(value - 1)}
          className="grid h-7 w-7 place-items-center rounded-full border border-slate-300 text-slate-600 hover:bg-slate-100 disabled:opacity-30">
          <Minus size={14} />
        </button>
        <span className="w-5 text-center text-sm font-semibold tabular-nums">{value}</span>
        <button type="button" aria-label={`More ${label}`} disabled={value >= max} onClick={() => onChange(value + 1)}
          className="grid h-7 w-7 place-items-center rounded-full border border-slate-300 text-slate-600 hover:bg-slate-100 disabled:opacity-30">
          <Plus size={14} />
        </button>
      </div>
    </div>
  );
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500">{icon}{title}</h2>
      {children}
    </section>
  );
}

export default function StartForm({ initial, onSubmit, busy }: { initial: TripInput; onSubmit: (input: TripInput) => void; busy: boolean }) {
  const [input, setInput] = useState<TripInput>(initial);
  const set = <K extends keyof TripInput>(k: K, v: TripInput[K]) => setInput((s) => ({ ...s, [k]: v }));
  const cities = input.cityIds.filter((id) => CITIES.some((c) => c.id === id));
  const pace = (input.presets.find((p) => p === "relaxed" || p === "balanced" || p === "packed") ?? "balanced") as PresetName;

  const toggleCity = (id: string) => {
    const on = cities.includes(id);
    let next = on ? input.cityIds.filter((x) => x !== id) : [...input.cityIds, id];
    if (id === "sambhajinagar" && on) next = next.filter((x) => !DAY_TRIPS.some((d) => d.id === x));
    const firstCity = next.find((x) => CITIES.some((c) => c.id === x)) ?? null;
    setInput((s) => ({ ...s, cityIds: next, arrivalCityId: s.arrivalCityId && next.includes(s.arrivalCityId) ? s.arrivalCityId : firstCity }));
  };
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const valid = cities.length > 0 && input.days >= 2 && input.travellers.adults + input.travellers.seniors >= 1 && !!input.startDate;

  return (
    <form
      className="mx-auto w-full max-w-3xl space-y-8 px-4 py-8 sm:py-12"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSubmit(input);
      }}
    >
      <header className="space-y-2">
        <p className="text-sm font-medium text-teal-700">Maharashtra trip planner</p>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Plan a trip that fits your people.</h1>
        <p className="max-w-2xl text-slate-600">
          Pick where and when. The planner works out the route, nights and a day-by-day schedule with real opening hours,
          travel times and rest — and explains every choice.
        </p>
      </header>

      <Section icon={<MapPin size={16} />} title="Destinations">
        <div className="grid gap-2 sm:grid-cols-2">
          {CITIES.map((c) => {
            const on = cities.includes(c.id);
            return (
              <button key={c.id} type="button" onClick={() => toggleCity(c.id)} aria-pressed={on}
                className={`rounded-xl border px-4 py-3 text-left transition ${on ? "border-teal-600 bg-teal-50 ring-1 ring-teal-600" : "border-slate-200 bg-white hover:border-slate-300"}`}>
                <span className="block font-medium">{c.name}</span>
                <span className="block text-sm text-slate-500">{c.blurb}</span>
              </button>
            );
          })}
        </div>
        {cities.includes("sambhajinagar") && (
          <div className="flex flex-wrap gap-2">
            {DAY_TRIPS.map((d) => (
              <label key={d.id} className="flex cursor-pointer items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-sm">
                <input type="checkbox" className="accent-teal-700" checked={input.cityIds.includes(d.id)} onChange={() => set("cityIds", toggle(input.cityIds, d.id))} />
                {d.name}
              </label>
            ))}
          </div>
        )}
        {cities.length > 1 && (
          <label className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
            Arriving in
            <select className="rounded-lg border border-slate-300 bg-white px-2 py-1" value={input.arrivalCityId ?? ""} onChange={(e) => set("arrivalCityId", e.target.value || null)}>
              {cities.map((id) => <option key={id} value={id}>{CITIES.find((c) => c.id === id)!.name}</option>)}
            </select>
          </label>
        )}
      </Section>

      <div className="grid gap-8 sm:grid-cols-2">
        <Section icon={<CalendarDays size={16} />} title="When">
          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1 text-sm text-slate-600">
              Start date
              <input type="date" required value={input.startDate ?? ""} onChange={(e) => set("startDate", e.target.value)}
                className="block w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-slate-900" />
            </label>
            <label className="space-y-1 text-sm text-slate-600">
              Days
              <input type="number" min={2} max={14} value={input.days} onChange={(e) => set("days", Math.max(2, Math.min(14, Number(e.target.value) || 2)))}
                className="block w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-slate-900" />
            </label>
          </div>
        </Section>
        <Section icon={<Users size={16} />} title="Travellers">
          <div className="space-y-2">
            <Stepper label="Adults" value={input.travellers.adults} min={0} max={10} onChange={(v) => set("travellers", { ...input.travellers, adults: v })} />
            <Stepper label="Kids" value={input.travellers.children} min={0} max={8} onChange={(v) => set("travellers", { ...input.travellers, children: v })} />
            <Stepper label="Seniors (65+)" value={input.travellers.seniors} min={0} max={8} onChange={(v) => set("travellers", { ...input.travellers, seniors: v })} />
          </div>
        </Section>
      </div>

      <div className="grid gap-8 sm:grid-cols-2">
        <Section icon={<Wallet size={16} />} title="Budget">
          <div className="grid grid-cols-3 gap-1 rounded-xl bg-slate-100 p-1">
            {TIERS.map((t) => (
              <button key={t.id} type="button" onClick={() => set("budgetTier", t.id)} aria-pressed={input.budgetTier === t.id}
                className={`rounded-lg px-2 py-2 text-sm font-medium ${input.budgetTier === t.id ? "bg-white shadow-sm" : "text-slate-600"}`}>{t.label}</button>
            ))}
          </div>
        </Section>
        <Section icon={<Sparkles size={16} />} title="Pace">
          <div className="grid grid-cols-3 gap-1 rounded-xl bg-slate-100 p-1">
            {PACES.map((p) => (
              <button key={p.id} type="button" title={p.hint} aria-pressed={pace === p.id}
                onClick={() => set("presets", [...input.presets.filter((x) => !["relaxed", "balanced", "packed"].includes(x)), p.id])}
                className={`rounded-lg px-2 py-2 text-sm font-medium ${pace === p.id ? "bg-white shadow-sm" : "text-slate-600"}`}>{p.label}</button>
            ))}
          </div>
          <p className="text-xs text-slate-500">{PACES.find((p) => p.id === pace)?.hint}</p>
        </Section>
      </div>

      <Section icon={<Sparkles size={16} />} title="Interests">
        <div className="flex flex-wrap gap-2">
          {INTERESTS.map((i) => {
            const on = input.interests.includes(i);
            return (
              <button key={i} type="button" onClick={() => set("interests", toggle(input.interests, i))} aria-pressed={on}
                className={`rounded-full border px-3 py-1.5 text-sm capitalize ${on ? "border-teal-600 bg-teal-600 text-white" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"}`}>{i}</button>
            );
          })}
        </div>
      </Section>

      <label className="block space-y-2">
        <span className="text-sm font-semibold uppercase tracking-wide text-slate-500">Anything else?</span>
        <textarea rows={3} value={input.chatText} onChange={(e) => set("chatText", e.target.value)} placeholder="e.g. we like late mornings, dad has bad knees, must see Ajanta"
          className="block w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-slate-900 placeholder:text-slate-400" />
      </label>

      <div className="sticky bottom-0 -mx-4 border-t border-slate-200 bg-slate-50/95 px-4 py-4 backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:p-0">
        <button type="submit" disabled={!valid || busy}
          className="w-full rounded-xl bg-teal-700 px-6 py-3 text-base font-semibold text-white shadow-sm hover:bg-teal-800 disabled:opacity-40 sm:w-auto">
          Plan my trip
        </button>
        {!valid && <p className="mt-2 text-sm text-slate-500">Pick at least one destination and one adult or senior.</p>}
      </div>
    </form>
  );
}
