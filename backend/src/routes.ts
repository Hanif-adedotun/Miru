import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { PlanRequest, PlanResponse, PlanStreamEvent } from "./types.js";
import { createId, truncate } from "./utils.js";

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
  const writeSseEvent = (reply: FastifyReply, event: PlanStreamEvent): void => {
    reply.raw.write(`event: ${event.event}\n`);
    reply.raw.write(`data: ${JSON.stringify(event.data)}\n\n`);
  };

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
      request.log.info(
        {
          sessionId,
          mode: requestBody.mode,
          promptPreview: truncate(requestBody.prompt, 120),
        },
        "POST /v1/plan: planning"
      );

      const proposedAction = await app.planner.plan(requestBody);

      request.log.info(
        {
          sessionId,
          actionType: proposedAction.action.type,
          risk: proposedAction.risk,
          requiresConfirmation: proposedAction.requiresConfirmation,
        },
        "POST /v1/plan: done"
      );

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

  app.post(
    "/v1/plan/stream",
    async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply): Promise<void> => {
      if (!isPlanRequest(request.body)) {
        reply.code(400);
        throw new Error("Invalid planning payload.");
      }

      const requestBody = request.body;
      const sessionId = requestBody.sessionId || createId();
      const messageId = createId();
      let streamClosed = false;

      request.log.info(
        {
          sessionId,
          mode: requestBody.mode,
          promptPreview: truncate(requestBody.prompt, 120),
        },
        "POST /v1/plan/stream: start"
      );

      reply.raw.on("close", () => {
        streamClosed = true;
      });

      reply.hijack();
      reply.raw.statusCode = 200;
      reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
      reply.raw.setHeader("Connection", "keep-alive");
      reply.raw.setHeader("X-Accel-Buffering", "no");
      reply.raw.flushHeaders();

      writeSseEvent(reply, {
        event: "assistant_message_start",
        data: {
          messageId,
          createdAt: Date.now(),
        },
      });

      try {
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

        request.log.info(
          {
            sessionId,
            actionType: proposedAction.action.type,
            risk: proposedAction.risk,
          },
          "POST /v1/plan/stream: plan resolved, streaming narration"
        );

        await app.planner.streamAlignedNarration(requestBody, proposedAction, (token) => {
          if (streamClosed) {
            return;
          }

          writeSseEvent(reply, {
            event: "assistant_token",
            data: {
              messageId,
              token,
              createdAt: Date.now(),
            },
          });
        });

        if (!streamClosed) {
          writeSseEvent(reply, {
            event: "plan_result",
            data: {
              sessionId,
              proposedAction,
              memory: {
                previousPlans,
                storedInSupabase: app.storage.isPersistent(),
              },
            },
          });
          writeSseEvent(reply, {
            event: "assistant_message_done",
            data: {
              messageId,
              createdAt: Date.now(),
            },
          });
        }

        request.log.info({ sessionId, streamClosed }, "POST /v1/plan/stream: complete");
      } catch (error) {
        request.log.error({ sessionId, err: error }, "POST /v1/plan/stream: failed");
        if (!streamClosed) {
          writeSseEvent(reply, {
            event: "assistant_message_error",
            data: {
              messageId,
              error: error instanceof Error ? error.message : "Planner stream failed.",
              createdAt: Date.now(),
            },
          });
        }
      } finally {
        if (!streamClosed) {
          reply.raw.end();
        }
      }
    }
  );
}
