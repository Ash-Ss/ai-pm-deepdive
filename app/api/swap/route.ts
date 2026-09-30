/** POST /api/swap { plan, itemId } → next best alternative from the pool (no LLM), that day re-scheduled. */
import { errorResponse, ItemBody, readBody } from "@/lib/server/http";
import { swapItem } from "@/lib/server/tripService";

export async function POST(req: Request) {
  const body = await readBody(req, ItemBody);
  if (!body.ok) return body.res;
  try {
    return Response.json(await swapItem(body.data.plan, body.data.itemId));
  } catch (e) {
    return errorResponse(e);
  }
}
