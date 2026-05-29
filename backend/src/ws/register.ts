import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";

import { parseRunEnvelope, type RunEnvelope } from "../shared/run-protocol.js";
import { RunOrchestrator } from "../run/orchestrator.js";
import { createId } from "../utils.js";

const orchestrators = new Map<string, RunOrchestrator>();

function sendEnvelope(socket: WebSocket, envelope: RunEnvelope): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(envelope));
  }
}

export async function registerWebSocketRoutes(app: FastifyInstance): Promise<void> {
  await app.register(websocket);

  app.get("/v1/runs/ws", { websocket: true }, (socket, request) => {
    const connectionId = createId();
    request.log.info({ connectionId }, "WS /v1/runs/ws: connected");

    const emit = (envelope: RunEnvelope): void => {
      sendEnvelope(socket, envelope);
    };

    const orchestrator = new RunOrchestrator(app, connectionId, emit);
    orchestrators.set(connectionId, orchestrator);

    socket.on("message", (raw) => {
      const text = typeof raw === "string" ? raw : raw.toString("utf8");
      const envelope = parseRunEnvelope(text);
      if (!envelope) {
        request.log.warn({ connectionId }, "WS: invalid envelope");
        return;
      }

      if (envelope.type === "client.hello") {
        request.log.info(
          { connectionId, extensionVersion: (envelope.payload as { extensionVersion?: string }).extensionVersion },
          "WS: client.hello"
        );
        return;
      }

      orchestrator.handleMessage(envelope);
    });

    socket.on("close", () => {
      request.log.info({ connectionId }, "WS /v1/runs/ws: closed");
      orchestrator.handleDisconnect();
      orchestrators.delete(connectionId);
    });

    socket.on("error", (error) => {
      request.log.error({ connectionId, err: error }, "WS /v1/runs/ws: error");
    });
  });
}
