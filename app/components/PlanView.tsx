"use client";

import { AlertTriangle, ArrowRight, Car, Code2, Lock, Pencil, Plane, Plus, TrainFront, X } from "lucide-react";
import { useState } from "react";
import type { PlanResponse } from "@/lib/server/tripService";
import type { Constraint } from "@/lib/types";
import { describeConstraint, hm, inr } from "@/lib/client/format";
import DayCard, { type DayActions } from "./DayCard";

export type ChipActions = { remove: (c: Constraint) => void; toggleStrength: (c: Constraint) => void };

function Chips({ constraints, names, actions, busy }: { constraints: Constraint[]; names: (id: string) => string; actions: ChipActions; busy: boolean }) {
  return (
    <div className="flex flex-wrap gap-1.5" aria-label="Constraints">
      {constraints.map((c) => {
        const label = describeConstraint(c, names);
        if (c.source === "form") {
          return (
            <span key={c.id} title="From the trip form — use Edit trip to change" className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-600">
              <Lock size={10} /> {label}
            </span>
          );
        }
        const planner = c.source === "default";
        return (
          <span key={c.id} className={`inline-flex items-center gap-1 rounded-full py-1 pl-2.5 pr-1 text-xs ${planner ? "bg-amber-50 text-amber-900 ring-1 ring-amber-200" : "bg-teal-50 text-teal-900 ring-1 ring-teal-200"}`}
            title={planner ? `Planner suggestion: ${c.sourceText ?? ""}. Remove to keep your usual start.` : c.sourceText ?? ""}>
            {planner && <span className="font-semibold">Suggested:</span>}
            {label}
            {!planner && (
              <button type="button" disabled={busy} onClick={() => actions.toggleStrength(c)} className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase hover:bg-white disabled:opacity-40"
                title="Switch between must and prefer">{c.strength === "hard" ? "must" : "prefer"}</button>
            )}
            <button type="button" disabled={busy} onClick={() => actions.remove(c)} aria-label={`Remove ${label}`} className="rounded-full p-0.5 hover:bg-white disabled:opacity-40"><X size={12} /></button>
          </span>
        );
      })}
    </div>
  );
}

function RouteStrip({ res }: { res: PlanResponse }) {
  const { plan, meta } = res;
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {plan.legs.map((leg, i) => {
          const hop = meta.route.hops.find((h) => h.to === leg.cityId);
          const Icon = hop?.mode === "flight" ? Plane : hop?.mode === "train" ? TrainFront : Car;
          return (
            <span key={leg.cityId} className="inline-flex items-center gap-2">
              {i > 0 && hop && (
                <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                  <ArrowRight size={12} /><Icon size={12} /> {hop.mode} · {hm(hop.minutes)}
                </span>
              )}
              <span className="rounded-xl bg-teal-50 px-3 py-1.5 font-medium text-teal-900">
                {meta.cities[leg.cityId]} <span className="text-teal-700">· {leg.nights} night{leg.nights === 1 ? "" : "s"}</span>
              </span>
            </span>
          );
        })}
      </div>
      {plan.summary?.route && <p className="mt-2 text-sm text-slate-600">{plan.summary.route}</p>}
    </section>
  );
}

function Warnings({ res }: { res: PlanResponse }) {
  const [open, setOpen] = useState(true);
  const hard = res.validation.hard;
  const items = [...hard.map((h) => `Day ${h.dayNumber}: ${h.detail}`), ...res.warnings, ...res.ai.fallbacks.map((f) => `AI fallback — ${f}`)];
  if (!items.length) return null;
  return (
    <section className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between text-left" aria-expanded={open}>
        <span className="flex items-center gap-2 font-semibold text-amber-900"><AlertTriangle size={16} /> Things to know ({items.length})</span>
        <span className="text-xs text-amber-800">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <ul className="mt-3 space-y-1.5 text-sm text-amber-950">
          {items.map((w, i) => <li key={i} className="flex gap-2"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />{w}</li>)}
        </ul>
      )}
    </section>
  );
}

function BehindTheScenes({ res }: { res: PlanResponse }) {
  return (
    <section className="space-y-2 rounded-2xl border border-slate-800 bg-slate-900 p-4 text-slate-100">
      <h2 className="flex items-center gap-2 font-semibold"><Code2 size={16} /> Behind the scenes</h2>
      <p className="text-xs text-slate-400">
        AI {res.ai.enabled ? "on" : "off"} · {res.ai.calls.length} LLM call(s)
        {res.ai.calls.map((c) => ` · ${c.name} ${c.cached ? "(cached)" : `${c.ms} ms`}`).join("")}
        {" "}· Every stage below returns its inputs, decisions and outputs.
      </p>
      {res.traces.map((t, i) => (
        <details key={`${t.stage}-${i}`} className="rounded-lg bg-slate-800/70 px-3 py-2">
          <summary className="cursor-pointer text-sm">
            <span className="font-mono text-teal-300">{t.stage}</span>
            <span className="text-slate-400"> · {t.decisions.length} decision(s) · {t.durationMs} ms</span>
          </summary>
          <div className="mt-2 space-y-2 text-xs">
            {t.decisions.length > 0 && (
              <ul className="space-y-1">
                {t.decisions.map((d, j) => <li key={j}><span className="text-slate-100">{d.what}</span> <span className="text-slate-400">— {d.why}</span></li>)}
              </ul>
            )}
            <pre className="max-h-72 overflow-auto rounded bg-slate-950 p-2 font-mono text-[11px] leading-relaxed text-slate-300">{JSON.stringify({ inputs: t.inputs, outputs: t.outputs }, null, 2)}</pre>
          </div>
        </details>
      ))}
    </section>
  );
}

export default function PlanView({
  res, dayActions, chipActions, busy, onEdit, onNew,
}: {
  res: PlanResponse;
  dayActions: DayActions;
  chipActions: ChipActions;
  busy: boolean;
  onEdit: () => void;
  onNew: () => void;
}) {
  const [behind, setBehind] = useState(false);
  const { plan, meta, validation } = res;
  const names = (id: string) => meta.names[id] ?? meta.cities[id] ?? id;
  const days = plan.legs.flatMap((l) => l.days);
  return (
    <div className="min-w-0 flex-1 space-y-4">
      <header className="space-y-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-teal-700">{plan.input.days}-day trip · est. {inr(validation.soft.budget.estimatedINR)} for {plan.input.travellers.adults + plan.input.travellers.children + plan.input.travellers.seniors} people</p>
            <h1 className="text-2xl font-semibold tracking-tight">Your Maharashtra plan</h1>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <button type="button" onClick={() => setBehind((b) => !b)} aria-pressed={behind} className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-sm ${behind ? "border-slate-800 bg-slate-900 text-white" : "border-slate-200 hover:bg-slate-50"}`}>
              <Code2 size={14} /> Behind the scenes
            </button>
            <button type="button" onClick={onEdit} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm hover:bg-slate-50"><Pencil size={14} /> Edit trip</button>
            <button type="button" onClick={onNew} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm hover:bg-slate-50"><Plus size={14} /> New</button>
          </div>
        </div>
        {plan.summary?.trip && <p className="text-slate-700">{plan.summary.trip}</p>}
        <Chips constraints={plan.constraints} names={names} actions={chipActions} busy={busy} />
      </header>

      {behind && <BehindTheScenes res={res} />}
      <RouteStrip res={res} />
      <Warnings res={res} />
      {days.map((d) => (
        <DayCard key={`${d.dayNumber}-${d.items.map((i) => i.refId).join()}`} day={d} meta={meta} levers={plan.levers}
          pace={validation.soft.pace.find((p) => p.dayNumber === d.dayNumber)} actions={dayActions} />
      ))}
      <p className="pb-24 text-center text-xs text-slate-400">
        Planner estimates only — check opening hours, prices and bookings before you travel. Map data © OpenStreetMap contributors.
      </p>
    </div>
  );
}
