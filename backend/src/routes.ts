import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { PlanRequest, PlanResponse } from "./types.js";
import { createId } from "./utils.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPlanRequest(value: unknown): value is PlanRequest {
  if (!isObject(value)) {
    return false;
  }

  if (typeof value.prompt !== "string" || typeof value.mode !== "string" || !isObject(value.context)) {
    return false;
  }

  return typeof value.context.url === "string" && typeof value.context.title === "string";
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({
    ok: true,
    service: "miru-backend",
    timestamp: Date.now(),
    storage: app.storage.isPersistent() ? "supabase" : "memory",
  }));

  app.post(
    "/v1/plan",
    async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply): Promise<PlanResponse> => {
      if (!isPlanRequest(request.body)) {
        reply.code(400);
        throw new Error("Invalid planning payload.");
      }

      const requestBody = request.body;
      const sessionId = requestBody.sessionId || createId();
      const proposedAction = await app.planner.plan(requestBody);

      const persisted = {
        sessionId,
        prompt: requestBody.prompt,
        mode: requestBody.mode,
        context: requestBody.context,
        proposedAction,
      };

      await app.storage.upsertSession(persisted);
      await app.storage.savePlan(persisted);

      const previousPlans = await app.storage.getPlanCount(sessionId);

      return {
        sessionId,
        proposedAction,
        memory: {
          previousPlans,
          storedInSupabase: app.storage.isPersistent(),
        },
      };
    }
  );
}
