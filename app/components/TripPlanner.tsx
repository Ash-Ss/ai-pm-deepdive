"use client";

import { useCallback, useEffect, useState } from "react";
import type { ClarifyingQuestion, ConstraintOp } from "@/lib/ai/extractConstraints";
import type { ChatResponse, PlanResponse } from "@/lib/server/tripService";
import type { Constraint, TripInput } from "@/lib/types";
import * as api from "@/lib/client/api";
import { describeConstraint } from "@/lib/client/format";
import { clearState, loadState, saveState } from "@/lib/client/storage";
import ChatPanel, { type ChatMessage } from "./ChatPanel";
import LoadingStages from "./LoadingStages";
import PlanView from "./PlanView";
import StartForm, { defaultTripInput } from "./StartForm";

type Saved = { tripInput: TripInput; chatConstraints: Constraint[]; res: PlanResponse | null; messages: ChatMessage[] };

let seq = 0;
const msgId = () => `m${Date.now().toString(36)}${seq++}`;

/** Rendered client-only (see ClientApp), so the saved trip can seed state directly. */
export default function TripPlanner() {
  const [saved] = useState(() => loadState<Saved>());
  const [view, setView] = useState<"form" | "loading" | "plan">(saved?.res ? "plan" : "form");
  const [tripInput, setTripInput] = useState<TripInput>(() => saved?.tripInput ?? defaultTripInput());
  const [chatConstraints, setChatConstraints] = useState<Constraint[]>(saved?.chatConstraints ?? []);
  const [res, setRes] = useState<PlanResponse | null>(saved?.res ?? null);
  const [messages, setMessages] = useState<ChatMessage[]>(saved?.messages ?? []);
  const [stage, setStage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Persist the current trip on every change (guarded: storage may be unavailable).
  useEffect(() => {
    saveState<Saved>({ tripInput, chatConstraints, res, messages });
  }, [tripInput, chatConstraints, res, messages]);

  const say = (m: Omit<ChatMessage, "id">) => setMessages((ms) => [...ms, { ...m, id: msgId() }]);
  const names = (r: PlanResponse | null) => (id: string) => r?.meta.names[id] ?? r?.meta.cities[id] ?? id;
  const chipLabels = (ops: ConstraintOp[], r: PlanResponse | null) =>
    ops.filter((o) => o.op !== "remove").map((o) => describeConstraint((o as { constraint: Constraint }).constraint, names(r)));

  // ---------------------------------------------------------------- plan
  const plan = useCallback(async (input: TripInput, constraints: Constraint[]) => {
    setError(null);
    setView("loading");
    setStage(null);
    try {
      const r = await api.planTrip(input, constraints, setStage);
      setRes(r);
      setChatConstraints(r.chatConstraints);
      // The free-text box is used once; afterwards its constraints live as chips.
      setTripInput({ ...input, chatText: "" });
      setView("plan");
      if (input.chatText.trim()) {
        const added = r.chatConstraints.map((c) => describeConstraint(c, names(r)));
        say({ role: "user", text: input.chatText });
        say({ role: "assistant", text: added.length ? "Got it — I've taken that into account." : "Noted.", chips: added, questions: r.clarifyingQuestions });
      } else if (r.clarifyingQuestions.length) {
        say({ role: "assistant", text: "One quick question to fine-tune the plan:", questions: r.clarifyingQuestions });
      }
    } catch (e) {
      setError((e as Error).message);
      setView(res ? "plan" : "form");
    }
  }, [res]);

  // ---------------------------------------------------------------- chat + chips
  /** Day edits return only their own traces; keep the plan's earlier ones for "behind the scenes". */
  const merge = (next: PlanResponse): PlanResponse =>
    next.tracesMode === "append" && res ? { ...next, traces: [...res.traces, ...next.traces], plan: { ...next.plan, traces: [...res.traces, ...next.traces] } } : next;

  const applyChat = (r: ChatResponse) => {
    if (r.updated) {
      setRes(merge(r.updated));
      setChatConstraints(r.updated.chatConstraints);
    }
    say({ role: "assistant", text: r.explanation, chips: chipLabels(r.constraintOps, r.updated ?? res), questions: r.clarifyingQuestions });
  };

  const runChat = async (body: Omit<Parameters<typeof api.sendChat>[0], "tripInput" | "constraints" | "plan">, key: string) => {
    if (!res) return;
    setBusy(key);
    try {
      applyChat(await api.sendChat({ ...body, tripInput, constraints: chatConstraints, plan: res.plan }));
    } catch (e) {
      say({ role: "assistant", text: `Sorry — ${(e as Error).message}`, tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  const onSend = (text: string) => {
    say({ role: "user", text });
    void runChat({ message: text }, "chat");
  };
  const onAnswer = (m: ChatMessage, q: ClarifyingQuestion, option: string) => {
    setMessages((ms) => ms.map((x) => (x.id === m.id ? { ...x, answered: true } : x)));
    say({ role: "user", text: option });
    void runChat({ answer: { question: q, option } }, "chat");
  };
  const chipActions = {
    remove: (c: Constraint) => {
      say({ role: "user", text: c.source === "default" ? `Keep the usual start instead (${describeConstraint(c, names(res))})` : `Remove "${describeConstraint(c, names(res))}"` });
      void runChat({ ops: [{ op: "remove", id: c.id }] }, "chip");
    },
    toggleStrength: (c: Constraint) => {
      const next = { ...c, strength: c.strength === "hard" ? "soft" : "hard" } as Constraint;
      say({ role: "user", text: `"${describeConstraint(c, names(res))}" is ${next.strength === "hard" ? "a must" : "a preference"}` });
      void runChat({ ops: [{ op: "update", constraint: next }] }, "chip");
    },
  };

  // ---------------------------------------------------------------- day edits
  const edit = async (key: string, call: () => Promise<api.EditResponse>) => {
    if (!res) return;
    setBusy(key);
    try {
      const r = await call();
      setRes(merge(r));
      setChatConstraints(r.chatConstraints);
      say({ role: "assistant", text: r.explanation, chips: chipLabels(r.constraintOps ?? [], r) });
    } catch (e) {
      say({ role: "assistant", text: `Couldn't do that: ${(e as Error).message}`, tone: "error" });
    } finally {
      setBusy(null);
    }
  };
  const dayActions = {
    busy,
    swap: (itemId: string) => edit(`swap-${itemId}`, () => api.swapItem(res!.plan, itemId)),
    remove: (itemId: string) => edit(`remove-${itemId}`, () => api.removeItem(res!.plan, itemId)),
    regenerate: (dayNumber: number, instructions?: string) => {
      if (instructions) say({ role: "user", text: `Regenerate day ${dayNumber}: ${instructions}` });
      return edit(`regen-${dayNumber}`, () => api.regenerateDay(res!.plan, dayNumber, chatConstraints, instructions));
    },
    // Locking is purely client-side: the flag travels with the plan and every server edit keeps it.
    toggleLock: (itemId: string) => {
      if (!res) return;
      const plan = structuredClone(res.plan);
      for (const d of plan.legs.flatMap((l) => l.days)) for (const i of d.items) if (i.id === itemId) i.locked = !i.locked;
      setRes({ ...res, plan });
    },
  };

  // ---------------------------------------------------------------- render
  if (view === "loading") return <LoadingStages current={stage} />;
  if (view === "form" || !res) {
    return (
      <>
        {error && <p role="alert" className="mx-auto mt-6 max-w-3xl rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-800">Planning failed: {error}</p>}
        <StartForm initial={tripInput} busy={false} onSubmit={(input) => { setTripInput(input); void plan(input, chatConstraints); }} />
      </>
    );
  }
  return (
    <main className="mx-auto flex w-full max-w-7xl gap-6 px-4 py-6">
      <PlanView
        res={res}
        dayActions={dayActions}
        chipActions={chipActions}
        busy={!!busy}
        onEdit={() => setView("form")}
        onNew={() => {
          clearState();
          setRes(null);
          setMessages([]);
          setChatConstraints([]);
          setTripInput(defaultTripInput());
          setView("form");
        }}
      />
      <ChatPanel messages={messages} busy={busy === "chat" || busy === "chip"} onSend={onSend} onAnswer={onAnswer} />
      {error && <p role="alert" className="fixed left-4 top-4 z-50 rounded-xl bg-rose-600 px-4 py-2 text-sm text-white shadow">{error}</p>}
    </main>
  );
}
