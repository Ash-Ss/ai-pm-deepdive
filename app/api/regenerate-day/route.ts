/** POST /api/regenerate-day { plan, dayIndex, instructions?, constraints } → updated plan (other days untouched, locked items kept). */
import { errorResponse, readBody, RegenerateBody } from "@/lib/server/http";
import { regenerateDay } from "@/lib/server/tripService";

export async function POST(req: Request) {
  const body = await readBody(req, RegenerateBody);
  if (!body.ok) return body.res;
  const { plan, dayIndex, instructions, constraints } = body.data;
  try {
    return Response.json(await regenerateDay(plan, dayIndex, constraints, { instructions }));
  } catch (e) {
    return errorResponse(e);
  }
}
