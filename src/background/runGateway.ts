import {
  createRunEnvelope,
  shouldInlineScreenshot,
  type RunEnvelope,
  type RunSessionSnapshot,
  type ServerOverlayCommandPayload,
} from "../shared/run-protocol.js";
import type {
  ChatMessage,
  MiruMode,
  ProposedAction,
  SessionEvent,
  SessionState,
  SessionStatus,
  StartSessionPayload,
  WorkflowStep,
} from "../shared/types.js";
import {
  capturePageContext,
  clearPageOverlay,
  executeActionOnTab,
  getActiveTab,
  getTabById,
  syncPageOverlay,
} from "./browserOps.js";
import {
  clearSession,
  createEmptySession,
  getActiveRun,
  getStoredSession,
  isRunActive,
  saveActiveRun,
  saveSession,
} from "./sessionStore.js";
import { broadcastStreamEvent } from "./streamHub.js";
import { wsClient } from "./wsClient.js";

let handlingContext = false;

function makeEvent(title: string, detail: string, status: SessionEvent["status"]): SessionEvent {
  return {
    id: crypto.randomUUID(),
    title,
    detail,
    status,
    createdAt: Date.now(),
  };
}

function toSnapshot(session: SessionState): RunSessionSnapshot {
  return {
    id: session.id,
    runId: session.runId ?? null,
    mode: session.mode,
    prompt: session.prompt,
    status: session.status,
    tabId: session.tabId,
    origin: session.origin,
    currentContext: session.currentContext,
    pendingAction: session.pendingAction,
    pendingAsk: session.pendingAsk,
    workflowSteps: session.workflowSteps ?? [],
    scrapeArtifacts: session.scrapeArtifacts ?? [],
    chatMessages: session.chatMessages ?? [],
    lastError: session.lastError,
    updatedAt: session.updatedAt,
  };
}

function broadcastSnapshot(session: SessionState): void {
  broadcastStreamEvent({ type: "run_snapshot", snapshot: toSnapshot(session) });
}

function mapRunStatusToSession(status: string): SessionStatus {
  switch (status) {
    case "requesting_context":
      return "capturing";
    case "planning":
      return "planning";
    case "awaiting_approval":
      return "awaiting_approval";
    case "awaiting_input":
      return "awaiting_input";
    case "executing":
      return "executing";
    case "completed":
    case "cancelled":
      return "ready";
    case "error":
      return "error";
    default:
      return "planning";
  }
}

async function applySessionUpdate(partial: Partial<SessionState>): Promise<SessionState> {
  const current = await getStoredSession();
  const next = await saveSession({ ...current, ...partial });
  broadcastSnapshot(next);
  return next;
}

async function sendContextSnapshot(runId: string, tabId: number): Promise<void> {
  if (handlingContext) {
    return;
  }
  handlingContext = true;
  try {
    const tab = await getTabById(tabId);
    const pageContext = await capturePageContext(tab);
    const inline = shouldInlineScreenshot(pageContext.screenshotDataUrl);

    await applySessionUpdate({
      currentContext: pageContext,
      tabId: tab.id,
      origin: tab.url ? new URL(tab.url).origin : undefined,
    });

    if (inline) {
      wsClient.send("client.context.snapshot", runId, { pageContext });
      return;
    }

    const { screenshotDataUrl, ...withoutShot } = pageContext;
    wsClient.send("client.context.snapshot", runId, {
      pageContext: withoutShot,
      screenshotOmitted: true,
    });

    if (screenshotDataUrl) {
      wsClient.send("client.context.screenshot", runId, { screenshotDataUrl });
    }
  } finally {
    handlingContext = false;
  }
}

async function handleServerEnvelope(envelope: RunEnvelope): Promise<void> {
  const { type, runId, payload } = envelope;

  if (envelope.seq !== undefined) {
    const active = await getActiveRun();
    if (active && active.runId === runId) {
      await saveActiveRun({ ...active, lastAckSeq: envelope.seq });
    }
  }

  switch (type) {
    case "server.run.started": {
      const p = payload as { runId: string; sessionId: string };
      const tab = await getActiveTab();
      await applySessionUpdate({
        id: p.sessionId,
        runId: p.runId,
        status: "planning",
        tabId: tab.id,
        origin: tab.url ? new URL(tab.url).origin : undefined,
      });
      await saveActiveRun({
        runId: p.runId,
        lastAckSeq: envelope.seq ?? 0,
        tabId: tab.id!,
      });
      break;
    }

    case "server.run.status": {
      const p = payload as { status: string; sessionStatus?: SessionStatus; label?: string };
      const sessionStatus = p.sessionStatus ?? mapRunStatusToSession(p.status);
      await applySessionUpdate({ status: sessionStatus });
      break;
    }

    case "server.context.request": {
      const active = await getActiveRun();
      const session = await getStoredSession();
      const tabId = active?.tabId ?? session.tabId;
      if (tabId && runId) {
        await sendContextSnapshot(runId, tabId);
      }
      break;
    }

    case "server.step.planned": {
      const p = payload as {
        step: WorkflowStep;
        proposedAction: ProposedAction;
        messageId: string;
      };
      const session = await getStoredSession();
      const steps = [...(session.workflowSteps ?? [])];
      const idx = steps.findIndex((s) => s.id === p.step.id);
      if (idx === -1) {
        steps.push(p.step);
      } else {
        steps[idx] = p.step;
      }
      await applySessionUpdate({
        workflowSteps: steps,
        pendingAction: p.proposedAction,
        status: "planning",
      });
      break;
    }

    case "server.step.running": {
      const p = payload as { stepId: string };
      const session = await getStoredSession();
      const steps = (session.workflowSteps ?? []).map((step) =>
        step.id === p.stepId ? { ...step, status: "running" as const, updatedAt: Date.now() } : step
      );
      await applySessionUpdate({ workflowSteps: steps, status: "executing" });
      break;
    }

    case "server.step.execute": {
      const p = payload as { stepId: string; action: import("../shared/types.js").MiruAction };
      const session = await getStoredSession();
      const tabId = session.tabId;
      if (!tabId) {
        wsClient.send("client.action.result", runId, {
          stepId: p.stepId,
          result: { success: false, error: "No tab bound to session." },
        });
        return;
      }

      const result = await executeActionOnTab(tabId, p.action);
      wsClient.send("client.action.result", runId, { stepId: p.stepId, result });

      if (result.success && p.action.type !== "STOP") {
        try {
          const tab = await getTabById(tabId);
          const ctx = await capturePageContext(tab);
          await applySessionUpdate({ currentContext: ctx });
        } catch {
          // context refresh is best-effort before next server cycle
        }
      }
      break;
    }

    case "server.step.completed": {
      const p = payload as { step: WorkflowStep; scrapeArtifact?: import("../shared/types.js").ScrapeArtifact };
      const session = await getStoredSession();
      const steps = (session.workflowSteps ?? []).map((step) =>
        step.id === p.step.id ? p.step : step
      );
      const artifacts = [...(session.scrapeArtifacts ?? [])];
      if (p.scrapeArtifact) {
        artifacts.push(p.scrapeArtifact);
      }
      await applySessionUpdate({
        workflowSteps: steps,
        scrapeArtifacts: artifacts,
        pendingAction: undefined,
      });
      break;
    }

    case "server.overlay.command": {
      const session = await getStoredSession();
      const overlay = payload as ServerOverlayCommandPayload;
      if (!overlay.active) {
        await clearPageOverlay(session.tabId);
      } else {
        await syncPageOverlay(session.tabId, overlay);
      }
      break;
    }

    case "server.chat.start": {
      const p = payload as { messageId: string; relatedStepId?: string };
      broadcastStreamEvent({
        type: "assistant_message_start",
        messageId: p.messageId,
        sessionId: (await getStoredSession()).id ?? undefined,
        createdAt: Date.now(),
      });
      const session = await getStoredSession();
      const messages: ChatMessage[] = [
        ...(session.chatMessages ?? []),
        {
          id: p.messageId,
          role: "assistant",
          content: "",
          status: "thinking",
          createdAt: Date.now(),
          relatedStepId: p.relatedStepId,
        },
      ];
      await applySessionUpdate({ chatMessages: messages.slice(-30) });
      break;
    }

    case "server.chat.token": {
      const p = payload as { messageId: string; token: string };
      broadcastStreamEvent({
        type: "assistant_token",
        messageId: p.messageId,
        token: p.token,
        createdAt: Date.now(),
      });
      break;
    }

    case "server.chat.done": {
      const p = payload as { messageId: string; error?: string };
      if (p.error) {
        broadcastStreamEvent({
          type: "assistant_message_error",
          messageId: p.messageId,
          error: p.error,
          createdAt: Date.now(),
        });
      } else {
        broadcastStreamEvent({
          type: "assistant_message_done",
          messageId: p.messageId,
          createdAt: Date.now(),
        });
      }
      break;
    }

    case "server.ask.user": {
      const p = payload as { pendingAsk: import("../shared/types.js").PendingAsk };
      await applySessionUpdate({
        pendingAsk: p.pendingAsk,
        pendingAction: undefined,
        status: "awaiting_input",
      });
      break;
    }

    case "server.run.awaiting_approval": {
      const p = payload as { proposedAction: ProposedAction };
      await applySessionUpdate({
        pendingAction: p.proposedAction,
        status: "awaiting_approval",
      });
      break;
    }

    case "server.run.completed": {
      const p = payload as {
        workflowSteps: WorkflowStep[];
        scrapeArtifacts: import("../shared/types.js").ScrapeArtifact[];
        reason?: string;
      };
      await saveActiveRun(null);
      const prior = await getStoredSession();
      const session = await applySessionUpdate({
        workflowSteps: p.workflowSteps,
        scrapeArtifacts: p.scrapeArtifacts,
        status: "ready",
        pendingAction: undefined,
        pendingAsk: undefined,
        runId: null,
        history: [
          ...prior.history,
          makeEvent("Run completed", p.reason ?? "Workflow finished", "success"),
        ],
      });
      await clearPageOverlay(session.tabId);
      wsClient.disconnect();
      break;
    }

    case "server.run.error": {
      const p = payload as { message: string; lastError?: string };
      const staleResume = /run not found/i.test(p.message);
      await saveActiveRun(null);
      const session = await getStoredSession();
      await applySessionUpdate({
        status: staleResume ? "ready" : "error",
        lastError: staleResume ? undefined : p.lastError ?? p.message,
        runId: null,
        pendingAction: undefined,
        history: staleResume
          ? session.history
          : [
              ...session.history,
              makeEvent("Run error", p.message, "error"),
            ],
      });
      await clearPageOverlay(session.tabId);
      // Keep the socket alive for the next run; only drop it when a run truly ended.
      if (!staleResume) {
        wsClient.disconnect();
      }
      break;
    }

    default:
      break;
  }

  broadcastStreamEvent({ type: "run_envelope", envelope });
}

async function ensureWsConnected(): Promise<void> {
  await wsClient.connect(handleServerEnvelope);
}

export function initRunGateway(): void {
  wsClient.setHandler(handleServerEnvelope);
}

export async function startRun(payload: StartSessionPayload): Promise<SessionState> {
  const tab = await getActiveTab();
  const base = createEmptySession();
  const session = await saveSession({
    ...base,
    id: crypto.randomUUID(),
    mode: payload.mode,
    prompt: payload.prompt.trim(),
    status: "capturing",
    tabId: tab.id,
    origin: tab.url ? new URL(tab.url).origin : undefined,
    history: [makeEvent("Run started", `Mode: ${payload.mode}`, "info")],
    workflowSteps: [],
    scrapeArtifacts: [],
    chatMessages: [
      ...(base.chatMessages ?? []).slice(0, 1),
      {
        id: crypto.randomUUID(),
        role: "user",
        content: payload.prompt.trim(),
        status: "complete",
        createdAt: Date.now(),
      },
    ],
  });

  broadcastSnapshot(session);

  await ensureWsConnected();

  wsClient.send("client.run.start", "", {
    prompt: payload.prompt.trim(),
    mode: payload.mode,
    tabId: tab.id!,
    origin: session.origin,
    url: tab.url,
  });

  return getStoredSession();
}

export async function resumeRunIfNeeded(): Promise<void> {
  const active = await getActiveRun();
  const session = await getStoredSession();
  if (!active?.runId || !session.runId) {
    return;
  }

  await ensureWsConnected();

  wsClient.send("client.run.resume", active.runId, {
    runId: active.runId,
    lastAckSeq: active.lastAckSeq,
    tabId: active.tabId,
  });
}

export async function approveRunStep(stepId: string): Promise<SessionState> {
  const session = await getStoredSession();
  if (!session.runId) {
    throw new Error("No active run.");
  }
  wsClient.send("client.run.approve", session.runId, { stepId });
  return getStoredSession();
}

export async function answerRunAsk(stepId: string, answer: string): Promise<SessionState> {
  const session = await getStoredSession();
  if (!session.runId) {
    throw new Error("No active run.");
  }
  wsClient.send("client.user.answer", session.runId, { stepId, answer });
  return getStoredSession();
}

export async function cancelRun(): Promise<SessionState> {
  const session = await getStoredSession();
  if (session.runId) {
    wsClient.send("client.run.cancel", session.runId, { reason: "User stopped" });
  }
  wsClient.disconnect();
  await saveActiveRun(null);
  return applySessionUpdate({
    runId: null,
    status: "ready",
    pendingAction: undefined,
    pendingAsk: undefined,
  });
}

export function shouldDeferNavigationRefresh(): boolean {
  return handlingContext;
}

export async function isActiveRunInProgress(): Promise<boolean> {
  const session = await getStoredSession();
  return isRunActive(session);
}

/** Cancel any active run, disconnect WS, and wipe stored session for a fresh chat. */
export async function resetSession(): Promise<SessionState> {
  const session = await getStoredSession();
  if (session.runId && wsClient.isOpen()) {
    try {
      wsClient.send("client.run.cancel", session.runId, { reason: "New chat" });
    } catch {
      // Socket may already be closed.
    }
  }
  wsClient.disconnect();
  await saveActiveRun(null);
  await clearPageOverlay(session.tabId);
  await clearSession();
  return createEmptySession();
}
