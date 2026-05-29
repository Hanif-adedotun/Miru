import Fastify from "fastify";

import { planNextAction, streamAlignedNarration, streamPlanNarration } from "./planner.js";
import { registerRoutes } from "./routes.js";
import { registerWebSocketRoutes } from "./ws/register.js";
import { createStorageAdapter, type StorageAdapter } from "./storage.js";
import type { PlanRequest, ProposedAction } from "./types.js";

declare module "fastify" {
  interface FastifyInstance {
    planner: {
      plan(request: PlanRequest): Promise<ProposedAction>;
      streamNarration(request: PlanRequest, onToken: (token: string) => Promise<void> | void): Promise<void>;
      streamAlignedNarration(
        request: PlanRequest,
        proposed: ProposedAction,
        onToken: (token: string) => Promise<void> | void
      ): Promise<void>;
    };
    storage: StorageAdapter;
  }
}

export async function buildApp() {
  const logLevel = process.env.LOG_LEVEL ?? "info";
  const app = Fastify({
    logger: {
      level: logLevel,
    },
  });

  app.addHook("onRequest", async (request) => {
    request.log.info(
      { method: request.method, url: request.url },
      `→ ${request.method} ${request.url}`
    );
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    reply.header("Access-Control-Allow-Headers", "Content-Type");
    return payload;
  });

  app.options("/*", async (_request, reply) => {
    reply.code(204).send();
  });

  app.decorate("planner", {
    plan: planNextAction,
    streamNarration: streamPlanNarration,
    streamAlignedNarration,
  });

  app.decorate("storage", createStorageAdapter());

  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    reply.code(reply.statusCode >= 400 ? reply.statusCode : 500).send({
      error: error instanceof Error ? error.message : "Unexpected backend error.",
    });
  });

  await registerRoutes(app);
  await registerWebSocketRoutes(app);
  return app;
}
