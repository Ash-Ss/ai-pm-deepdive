"use client";

import { Loader2, MessageSquare, Send, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ClarifyingQuestion } from "@/lib/ai/extractConstraints";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Constraint chips this turn added, e.g. "Vegetarian". */
  chips?: string[];
  questions?: ClarifyingQuestion[];
  answered?: boolean;
  tone?: "error";
};

const SUGGESTIONS = ["Make day 2 more relaxed", "Remove Elephanta", "We are vegetarian", "Add the fort"];

function Thread({ messages, busy, onSend, onAnswer }: { messages: ChatMessage[]; busy: boolean; onSend: (t: string) => void; onAnswer: (m: ChatMessage, q: ClarifyingQuestion, option: string) => void }) {
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ behavior: "smooth", block: "end" }), [messages.length, busy]);
  const send = (t: string) => {
    if (!t.trim() || busy) return;
    onSend(t.trim());
    setText("");
  };
  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 && (
          <div className="space-y-2 text-sm text-slate-500">
            <p>Ask for changes in plain words. Try:</p>
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" onClick={() => send(s)} className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-700 hover:border-teal-600">{s}</button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[88%] space-y-2 rounded-2xl px-3 py-2 text-sm ${m.role === "user" ? "bg-teal-700 text-white" : m.tone === "error" ? "bg-rose-50 text-rose-800" : "bg-slate-100 text-slate-800"}`}>
              <p>{m.text}</p>
              {m.chips && m.chips.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {m.chips.map((c) => <span key={c} className="rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-teal-800 ring-1 ring-teal-200">+ {c}</span>)}
                </div>
              )}
              {m.questions?.map((q) => (
                <div key={q.id} className="space-y-1.5">
                  <p className="font-medium">{q.text}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {q.options.map((o) => (
                      <button key={o} type="button" disabled={busy || m.answered} onClick={() => onAnswer(m, q, o)}
                        className="rounded-full border border-teal-600 bg-white px-2.5 py-1 text-xs font-medium text-teal-800 hover:bg-teal-50 disabled:opacity-40">{o}</button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
        {busy && <div className="flex items-center gap-2 text-sm text-slate-500"><Loader2 size={14} className="animate-spin" /> Updating the plan…</div>}
        <div ref={end} />
      </div>
      <form className="flex gap-2 border-t border-slate-200 p-3" onSubmit={(e) => { e.preventDefault(); send(text); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. make day 2 more relaxed" aria-label="Message"
          className="min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm" />
        <button disabled={busy || !text.trim()} aria-label="Send" className="grid h-9 w-9 place-items-center rounded-xl bg-teal-700 text-white hover:bg-teal-800 disabled:opacity-40">
          <Send size={16} />
        </button>
      </form>
    </div>
  );
}

/** Right column on desktop; floating button + bottom sheet on mobile. */
export default function ChatPanel(props: { messages: ChatMessage[]; busy: boolean; onSend: (t: string) => void; onAnswer: (m: ChatMessage, q: ClarifyingQuestion, option: string) => void }) {
  const [open, setOpen] = useState(false);
  const pending = props.messages.some((m) => m.questions?.length && !m.answered);
  return (
    <>
      <aside className="sticky top-4 hidden h-[calc(100vh-2rem)] w-96 shrink-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm lg:flex">
        <h2 className="flex items-center gap-2 border-b border-slate-200 px-4 py-3 font-semibold"><MessageSquare size={16} /> Refine the plan</h2>
        <Thread {...props} />
      </aside>

      <button type="button" onClick={() => setOpen(true)} className="fixed bottom-4 right-4 z-30 inline-flex items-center gap-2 rounded-full bg-teal-700 px-4 py-3 font-medium text-white shadow-lg lg:hidden">
        <MessageSquare size={18} /> Chat {pending && <span className="h-2 w-2 rounded-full bg-amber-400" aria-label="A question is waiting" />}
      </button>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Refine the plan">
          <button type="button" aria-label="Close chat" className="absolute inset-0 bg-slate-900/40" onClick={() => setOpen(false)} />
          <div className="animate-sheet-up absolute inset-x-0 bottom-0 flex h-[75vh] flex-col rounded-t-2xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <h2 className="font-semibold">Refine the plan</h2>
              <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="rounded-lg p-1 hover:bg-slate-100"><X size={18} /></button>
            </div>
            <div className="min-h-0 flex-1"><Thread {...props} /></div>
          </div>
        </div>
      )}
    </>
  );
}
