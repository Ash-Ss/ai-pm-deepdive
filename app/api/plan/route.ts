/**
 * POST /api/plan  { tripInput, constraints } → PlanResponse
 * With ?stream=1 the response is NDJSON: {type:"stage",stage} lines while planning,
 * then {type:"result",data} (or {type:"error",message}).
 */
import { errorResponse, PlanBody, readBody } from "@/lib/server/http";
import { createPlan } from "@/lib/server/tripService";

export async function POST(req: Request) {
  const body = await readBody(req, PlanBody);
  if (!body.ok) return body.res;
  const { tripInput, constraints } = body.data;

  if (new URL(req.url).searchParams.get("stream") !== "1") {
    try {
      return Response.json(await createPlan(tripInput, constraints));
    } catch (e) {
      return errorResponse(e);
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (o: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(o)}\n`));
      try {
        const data = await createPlan(tripInput, constraints, { onStage: (stage) => send({ type: "stage", stage }) });
        send({ type: "result", data });
      } catch (e) {
        send({ type: "error", message: e instanceof Error ? e.message : "Planning failed" });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}
