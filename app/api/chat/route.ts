/**
 * POST /api/chat  { message | answer | ops, tripInput, constraints, plan }
 *   → { intent, constraintOps, clarifyingQuestion?, updated?, changedScope, explanation }
 */
import { ChatBody, errorResponse, readBody } from "@/lib/server/http";
import { chat } from "@/lib/server/tripService";

export async function POST(req: Request) {
  const body = await readBody(req, ChatBody);
  if (!body.ok) return body.res;
  try {
    return Response.json(await chat(body.data));
  } catch (e) {
    return errorResponse(e);
  }
}
