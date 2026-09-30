/**
 * Route-handler helpers: validate the JSON body with zod, turn thrown errors
 * into JSON responses. Error messages never include secrets (the key is only
 * read inside lib/llm.ts and never echoed).
 */
import { z } from "zod";
import { Constraint, Plan, TripInput } from "../types";

export const PlanBody = z.object({ tripInput: TripInput, constraints: z.array(Constraint).default([]) });

/** Clients send plans back without traces (they're large and not needed for edits). */
export const PlanIn = Plan.extend({ traces: z.array(z.any()).default([]) });

const Question = z.object({
  id: z.string(),
  kind: z.enum(["mobility", "place", "freeform"]),
  text: z.string(),
  options: z.array(z.string()),
  pending: z.any().optional(),
});
const Op = z.union([
  z.object({ op: z.enum(["add", "update"]), constraint: Constraint }),
  z.object({ op: z.literal("remove"), id: z.string() }),
]);

export const ChatBody = z.object({
  message: z.string().max(2000).optional(),
  answer: z.object({ question: Question, option: z.string() }).optional(),
  ops: z.array(Op).optional(),
  tripInput: TripInput,
  constraints: z.array(Constraint).default([]),
  plan: PlanIn.optional(),
}).refine((b) => b.message || b.answer || b.ops, "Send a message, an answer or ops");

export const RegenerateBody = z.object({
  plan: PlanIn,
  dayIndex: z.number().int().positive(),
  instructions: z.string().max(1000).optional(),
  constraints: z.array(Constraint).default([]),
});

export const ItemBody = z.object({ plan: PlanIn, itemId: z.string() });

export async function readBody<T extends z.ZodType>(req: Request, schema: T): Promise<{ ok: true; data: z.infer<T> } | { ok: false; res: Response }> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { ok: false, res: Response.json({ error: "Body must be JSON" }, { status: 400 }) };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, res: Response.json({ error: `Invalid request: ${issue.path.join(".")} ${issue.message}` }, { status: 400 }) };
  }
  return { ok: true, data: parsed.data };
}

export function errorResponse(e: unknown): Response {
  const message = e instanceof Error ? e.message : "Something went wrong";
  console.error("[api]", message);
  return Response.json({ error: message }, { status: 500 });
}
