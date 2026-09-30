/**
 * Browser-side API calls. Plans go back to the server without traces (they're
 * large and only needed for the behind-the-scenes view).
 */
import type { ClarifyingQuestion, ConstraintOp } from "@/lib/ai/extractConstraints";
import type { ChatResponse, PlanResponse } from "@/lib/server/tripService";
import type { Constraint, Plan, TripInput } from "@/lib/types";

export type EditResponse = PlanResponse & { explanation: string; constraintOps?: ConstraintOp[] };

const slim = (plan: Plan): Plan => ({ ...plan, traces: [] });

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as T;
}

/** POST /api/plan?stream=1 — calls onStage for each pipeline stage, resolves with the plan. */
export async function planTrip(tripInput: TripInput, constraints: Constraint[], onStage: (stage: string) => void): Promise<PlanResponse> {
  const res = await fetch("/api/plan?stream=1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tripInput, constraints }),
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.type === "stage") onStage(msg.stage);
      if (msg.type === "error") throw new Error(msg.message);
      if (msg.type === "result") return msg.data as PlanResponse;
    }
  }
  throw new Error("The planner stopped without a result");
}

export const sendChat = (body: {
  message?: string;
  answer?: { question: ClarifyingQuestion; option: string };
  ops?: ConstraintOp[];
  tripInput: TripInput;
  constraints: Constraint[];
  plan?: Plan;
}) => post<ChatResponse>("/api/chat", { ...body, plan: body.plan ? slim(body.plan) : undefined });

export const swapItem = (plan: Plan, itemId: string) => post<EditResponse>("/api/swap", { plan: slim(plan), itemId });
export const removeItem = (plan: Plan, itemId: string) => post<EditResponse>("/api/remove", { plan: slim(plan), itemId });
export const regenerateDay = (plan: Plan, dayIndex: number, constraints: Constraint[], instructions?: string) =>
  post<EditResponse>("/api/regenerate-day", { plan: slim(plan), dayIndex, constraints, instructions });
