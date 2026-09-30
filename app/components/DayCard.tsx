"use client";

import {
  Armchair, BedDouble, Car, ChevronDown, Coffee, Footprints, Landmark, Loader2, Lock, LockOpen, Map as MapIcon, Mountain,
  Plane, RefreshCw, Replace, Scale, TrainFront, Trash2, Utensils,
} from "lucide-react";
import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import type { PlanMeta } from "@/lib/server/tripService";
import type { Day, Item, Levers } from "@/lib/types";
import { hm, inr, minutesBetween, SHORT_DATE, WEEKDAY } from "@/lib/client/format";

const DayMap = dynamic(() => import("./DayMap"), { ssr: false, loading: () => <div className="h-64 animate-pulse rounded-xl bg-slate-100" /> });

export type DayActions = {
  swap: (itemId: string) => void;
  remove: (itemId: string) => void;
  toggleLock: (itemId: string) => void;
  regenerate: (dayNumber: number, instructions?: string) => void;
  busy: string | null;
};

type Pace = { majorItems: number; maxMajorItems: number };

function Meter({ label, value, max, unit }: { label: string; value: number; max: number; unit: string }) {
  const pct = Math.min(100, Math.round((value / Math.max(max, 0.01)) * 100));
  const over = value > max;
  return (
    <div className="min-w-0 flex-1">
      <div className="flex justify-between text-[11px] text-slate-500"><span>{label}</span><span className={over ? "font-semibold text-rose-600" : ""}>{value}{unit} / {max}{unit}</span></div>
      <div className="mt-1 h-1.5 rounded-full bg-slate-200"><div className={`h-1.5 rounded-full ${over ? "bg-rose-500" : pct > 85 ? "bg-amber-500" : "bg-teal-600"}`} style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

function TransferRow({ item }: { item: Item }) {
  const mode = item.transfer?.mode;
  const mins = minutesBetween(item.startTime, item.endTime);
  const Icon = mode === "walk" ? Footprints : mode === "flight" ? Plane : mode === "train" ? TrainFront : Car;
  const big = mode === "flight" || mode === "train" || mode === "road";
  if (!big && mins === 0) {
    return <div className="flex items-center gap-2 py-1 pl-16 text-xs text-slate-500"><Icon size={13} /> {item.title}</div>;
  }
  return (
    <div className={`flex items-start gap-2 py-1 pl-16 text-xs ${big ? "text-slate-700" : "text-slate-500"}`}>
      <Icon size={13} className="mt-0.5 shrink-0" />
      <span>
        {big ? item.title : `${mode === "walk" ? "Walk" : "Auto/taxi"} · ${hm(mins)}${item.transfer?.distanceKm ? ` · ${item.transfer.distanceKm} km` : ""}`}
        {item.costINR ? <span className="text-slate-400"> · est. {inr(item.costINR)}</span> : null}
        {item.assumed && <span className="ml-1 rounded bg-slate-200 px-1 text-[10px] font-medium uppercase text-slate-600">assumed</span>}
        {big && item.tradeoffs.map((t) => <span key={t} className="block text-slate-500">{t}</span>)}
      </span>
    </div>
  );
}

function AccessIcons({ a }: { a: NonNullable<PlanMeta["places"][string]["accessibility"]> }) {
  const stairs = { none: "No stairs", low: "Few steps", medium: "Some stairs", high: "Many stairs" }[a.stairsLevel] ?? a.stairsLevel;
  return (
    <span className="flex flex-wrap gap-1.5 text-[11px] text-slate-600">
      <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5" title="Stairs"><Landmark size={11} /> {stairs}</span>
      <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5" title="Terrain"><Mountain size={11} /> {a.terrain}</span>
      <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5" title="Walking on site"><Footprints size={11} /> ~{a.walkingRequiredM >= 1000 ? `${(a.walkingRequiredM / 1000).toFixed(1)} km` : `${a.walkingRequiredM} m`}</span>
      {a.seating && <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5" title="Seating available"><Armchair size={11} /> seating</span>}
    </span>
  );
}

function ActivityRow({ item, meta, actions }: { item: Item; meta: PlanMeta; actions: DayActions }) {
  const [open, setOpen] = useState(false);
  const place = item.refId ? meta.places[item.refId] : undefined;
  const mins = minutesBetween(item.startTime, item.endTime);
  const busy = actions.busy?.endsWith(item.id);
  return (
    <div className={`rounded-xl border bg-white p-3 ${item.locked ? "border-teal-600" : "border-slate-200"}`}>
      <div className="flex gap-3">
        <div className="w-12 shrink-0 text-right text-sm font-semibold tabular-nums text-slate-900">{item.startTime}<span className="block text-[11px] font-normal text-slate-400">{hm(mins)}</span></div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium">{item.title}</span>
            {item.locked && <Lock size={13} className="text-teal-700" aria-label="Locked" />}
            {item.tradeoffs.length > 0 && <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800"><Scale size={11} /> tradeoff</span>}
            {place && place.confidence < 0.8 && (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600" title="Draft data: check hours and prices before you go">estimated</span>
            )}
            {item.costINR ? <span className="text-xs text-slate-500">est. {inr(item.costINR)}</span> : null}
          </div>
          {place?.accessibility && <AccessIcons a={place.accessibility} />}
          {item.tradeoffs.map((t) => <p key={t} className="rounded-lg bg-amber-50 px-2 py-1 text-xs text-amber-900">{t}</p>)}
          <button type="button" onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1 text-xs font-medium text-teal-700" aria-expanded={open}>
            Why this <ChevronDown size={13} className={`transition ${open ? "rotate-180" : ""}`} />
          </button>
          {open && (
            <div className="space-y-1 rounded-lg bg-slate-50 p-2 text-xs text-slate-700">
              {item.narration && <p>{item.narration}</p>}
              {item.whySelected.length > 0 && <ul className="list-disc pl-4 text-slate-500">{item.whySelected.map((w) => <li key={w}>{w}</li>)}</ul>}
              {place?.description && <p className="text-slate-500">{place.description}</p>}
              {item.costBasis && <p className="text-slate-400">Cost basis: {item.costBasis}</p>}
            </div>
          )}
          <div className="flex flex-wrap gap-1.5 pt-1">
            <button type="button" disabled={!!actions.busy} onClick={() => actions.swap(item.id)} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs hover:bg-slate-50 disabled:opacity-40">
              {busy && actions.busy?.startsWith("swap") ? <Loader2 size={12} className="animate-spin" /> : <Replace size={12} />} Swap
            </button>
            <button type="button" disabled={!!actions.busy} onClick={() => actions.toggleLock(item.id)} aria-pressed={item.locked}
              className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs disabled:opacity-40 ${item.locked ? "border-teal-600 bg-teal-50 text-teal-800" : "border-slate-200 hover:bg-slate-50"}`}>
              {item.locked ? <Lock size={12} /> : <LockOpen size={12} />} {item.locked ? "Locked" : "Lock"}
            </button>
            <button type="button" disabled={!!actions.busy || item.locked} onClick={() => actions.remove(item.id)} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs text-rose-700 hover:bg-rose-50 disabled:opacity-40">
              {busy && actions.busy?.startsWith("remove") ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />} Remove
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SimpleRow({ item, meta }: { item: Item; meta: PlanMeta }) {
  const mins = minutesBetween(item.startTime, item.endTime);
  const Icon = item.type === "meal" ? Utensils : item.type === "hotel" ? BedDouble : item.type === "rest" ? Coffee : Coffee;
  const tone = item.type === "meal" ? "text-amber-800" : "text-slate-500";
  const veg = item.type === "meal" && item.refId ? meta.places[item.refId]?.dietary : undefined;
  return (
    <div className={`flex items-start gap-3 py-1 text-sm ${tone}`}>
      <span className="w-12 shrink-0 text-right text-xs tabular-nums text-slate-400">{item.startTime}</span>
      <Icon size={14} className="mt-0.5 shrink-0" />
      <span className="min-w-0">
        {item.title}
        {mins > 0 && item.type !== "meal" && <span className="text-xs text-slate-400"> · {hm(mins)}</span>}
        {veg && <span className="ml-1 text-[11px] text-emerald-700">{veg.jain ? "veg · Jain" : veg.veg ? (veg.nonVeg ? "veg options" : "pure veg") : ""}</span>}
        {item.costINR ? <span className="text-xs text-slate-400"> · est. {inr(item.costINR)}</span> : null}
        {item.assumed && <span className="ml-1 rounded bg-slate-200 px-1 text-[10px] font-medium uppercase text-slate-600">assumed</span>}
        {item.tradeoffs.map((t) => <span key={t} className="block text-xs text-amber-800">{t}</span>)}
      </span>
    </div>
  );
}

export default function DayCard({ day, meta, levers, pace, actions }: { day: Day; meta: PlanMeta; levers: Levers; pace?: Pace; actions: DayActions }) {
  const [showMap, setShowMap] = useState(false);
  const [askRegen, setAskRegen] = useState(false);
  const [instructions, setInstructions] = useState("");
  const regenBusy = actions.busy === `regen-${day.dayNumber}`;
  // Memoised so the map isn't rebuilt on every render.
  const stops = useMemo(
    () => day.items
      .filter((i) => (i.type === "activity" || i.type === "meal") && i.refId && meta.places[i.refId]?.lat)
      .map((s, i) => ({ n: i + 1, name: s.title, lat: meta.places[s.refId!].lat, lng: meta.places[s.refId!].lng, kind: s.type === "meal" ? ("meal" as const) : ("activity" as const) })),
    [day.items, meta.places],
  );

  return (
    <article className="rounded-2xl border border-slate-200 bg-white shadow-sm" id={`day-${day.dayNumber}`}>
      <header className="space-y-3 border-b border-slate-100 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-teal-700">
              Day {day.dayNumber} · {day.date ? `${WEEKDAY(day.date)} ${SHORT_DATE(day.date)}` : ""} · {meta.cities[day.cityId]}
            </p>
            <h3 className="text-lg font-semibold">{day.title}</h3>
          </div>
          <div className="flex gap-1.5">
            <button type="button" onClick={() => setShowMap((s) => !s)} aria-pressed={showMap} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs hover:bg-slate-50">
              <MapIcon size={13} /> Map
            </button>
            <button type="button" disabled={!!actions.busy} onClick={() => setAskRegen((s) => !s)} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs hover:bg-slate-50 disabled:opacity-40">
              {regenBusy ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Regenerate day
            </button>
          </div>
        </div>
        {day.intro && <p className="text-sm text-slate-600">{day.intro}</p>}
        {askRegen && (
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); actions.regenerate(day.dayNumber, instructions || undefined); setAskRegen(false); setInstructions(""); }}>
            <input value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="Optional: e.g. more relaxed, more food" className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2 py-1 text-sm" />
            <button className="rounded-lg bg-teal-700 px-3 py-1 text-sm font-medium text-white hover:bg-teal-800">Go</button>
          </form>
        )}
        <div className="flex gap-4">
          {pace && <Meter label="Sights" value={pace.majorItems} max={pace.maxMajorItems} unit="" />}
          <Meter label="Walking" value={day.totals.walkKm} max={levers.maxWalkKmPerDay} unit=" km" />
          <Meter label="Local travel" value={day.totals.transitMin} max={levers.maxTransitMinPerDay} unit=" min" />
        </div>
      </header>
      {showMap && (
        <div className="border-b border-slate-100 p-3">
          <DayMap stops={stops} />
        </div>
      )}
      <div className="space-y-2 p-4">
        {day.items.map((item) =>
          item.type === "activity" ? <ActivityRow key={item.id} item={item} meta={meta} actions={actions} />
            : item.type === "transfer" ? <TransferRow key={item.id} item={item} />
              : <SimpleRow key={item.id} item={item} meta={meta} />,
        )}
        <p className="pt-2 text-right text-xs text-slate-400">Day total est. {inr(day.totals.costINR)}</p>
      </div>
    </article>
  );
}
