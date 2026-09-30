/** POST /api/remove { plan, itemId } → item removed (remembered as a soft exclusion), that day re-scheduled. */
import { errorResponse, ItemBody, readBody } from "@/lib/server/http";
import { removeItem } from "@/lib/server/tripService";

export async function POST(req: Request) {
  const body = await readBody(req, ItemBody);
  if (!body.ok) return body.res;
  try {
    return Response.json(await removeItem(body.data.plan, body.data.itemId));
  } catch (e) {
    return errorResponse(e);
  }
}
