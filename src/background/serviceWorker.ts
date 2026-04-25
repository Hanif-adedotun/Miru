/**
 * Background service worker for Miru
 * Orchestrates session state, page capture, planning, and constrained execution
 */

import { fetchNextActionStream } from "./plannerClient.js";
import {
  DEFAULT_PROMPT,
  MAX_HISTORY_ITEMS,
  MESSAGE_SOURCE,
  SCREENSHOT_QUALITY,
  SESSION_STORAGE_KEY,
} from "../shared/constants.js";
import type {
  ActionResultMessage,
  ActionResultPayload,
  ChatMessage,
  ErrorMessage,
  ExportScriptResponseMessage,
  Message,
  MiruAction,
  MiruMode,
  PageContext,
  PlannerStreamEvent,
  ProposedAction,
  PlannerRequest,
  RecordedSession,
  SessionEvent,
  SessionResponseMessage,
  SessionState,
  SessionStreamEventMessage,
  StartSessionPayload,
  WorkflowStep,
  WorkflowStepStatus,
} from "../shared/types.js";

const SESSION_STREAM_PORT = "miru-session-stream";
const streamPorts = new Set<chrome.runtime.Port>();

function createEmptySession(): SessionState {
  return {
    id: null,
    mode: "interactive",
    prompt: DEFAULT_PROMPT,
    status: "idle",
    history: [],
    workflowSteps: [],
    chatMessages: [
      {
        id: crypto.randomUUID(),
        role: "assistant",
        content:
          "Describe the crawl or extraction flow you want. Miru will think in chat, run commands on the page, and can record the session as an exportable script.",
        status: "complete",
        createdAt: Date.now(),
      },
    ],
    isRecording: false,
    updatedAt: Date.now(),
  };
}

void chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error("[Miru] Failed to enable side panel action behavior:", error));

function broadcastStreamEvent(event: PlannerStreamEvent): void {
  const message: SessionStreamEventMessage = {
    type: "SESSION_STREAM_EVENT",
    payload: event,
  };

  for (const port of streamPorts) {
    try {
      port.postMessage(message);
    } catch {
      streamPorts.delete(port);
    }
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== SESSION_STREAM_PORT) {
    return;
  }

  streamPorts.add(port);
  port.onDisconnect.addListener(() => {
    streamPorts.delete(port);
  });
});

function makeEvent(title: string, detail: string, status: SessionEvent["status"]): SessionEvent {
  return {
    id: crypto.randomUUID(),
    title,
    detail,
    status,
    createdAt: Date.now(),
  };
}

function createChatMessage(
  role: ChatMessage["role"],
  content: string,
  status: ChatMessage["status"] = "complete",
  relatedStepId?: string
): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    status,
    createdAt: Date.now(),
    relatedStepId,
  };
}

function updateStepStatus(
  workflowSteps: WorkflowStep[] | undefined,
  stepId: string,
  status: WorkflowStepStatus,
  resultSummary?: string
): WorkflowStep[] {
  return (workflowSteps ?? []).map((step) =>
    step.id === stepId
      ? {
          ...step,
          status,
          resultSummary: resultSummary ?? step.resultSummary,
          updatedAt: Date.now(),
        }
      : step
  );
}

function appendChatMessages(session: SessionState, ...messages: ChatMessage[]): SessionState {
  return {
    ...session,
    chatMessages: [...(session.chatMessages ?? []), ...messages].slice(-24),
  };
}

function upsertChatMessage(session: SessionState, message: ChatMessage): SessionState {
  const current = session.chatMessages ?? [];
  const index = current.findIndex((item) => item.id === message.id);
  if (index === -1) {
    return appendChatMessages(session, message);
  }

  const next = [...current];
  next[index] = { ...next[index], ...message };
  return {
    ...session,
    chatMessages: next.slice(-24),
  };
}

function appendTokenToMessage(
  session: SessionState,
  messageId: string,
  token: string,
  status: ChatMessage["status"] = "thinking"
): SessionState {
  const current = session.chatMessages ?? [];
  const index = current.findIndex((item) => item.id === messageId);
  if (index === -1) {
    return appendChatMessages(
      session,
      createChatMessage("assistant", token, status)
    );
  }

  const next = [...current];
  next[index] = {
    ...next[index],
    content: `${next[index].content}${token}`,
    status,
  };
  return {
    ...session,
    chatMessages: next.slice(-24),
  };
}

function setMessageStatus(
  session: SessionState,
  messageId: string,
  status: ChatMessage["status"],
  fallback?: string
): SessionState {
  const current = session.chatMessages ?? [];
  const index = current.findIndex((item) => item.id === messageId);
  if (index === -1) {
    return fallback ? appendChatMessages(session, createChatMessage("assistant", fallback, status)) : session;
  }

  const next = [...current];
  next[index] = {
    ...next[index],
    status,
    content: fallback ? `${next[index].content}\n${fallback}` : next[index].content,
  };
  return {
    ...session,
    chatMessages: next.slice(-24),
  };
}

function actionToScript(action: MiruAction): string {
  switch (action.type) {
    case "QUERY":
      return `await query(${JSON.stringify(action.selector)});`;
    case "CLICK":
      return `await click(${JSON.stringify(action.selector)});`;
    case "TYPE":
      return `await type(${JSON.stringify(action.selector)}, ${JSON.stringify(action.text)});`;
    case "SCROLL":
      return `await scroll(${JSON.stringify(action.direction)}, ${JSON.stringify(action.amount ?? null)});`;
    case "WAIT":
      return `await wait(${action.durationMs});`;
    case "EXTRACT":
      return `await extract(${JSON.stringify(action.fields, null, 2)});`;
    case "STOP":
      return `return { stopped: true, reason: ${JSON.stringify(action.reason)} };`;
    default:
      return "// Unsupported command";
  }
}

function buildExportedScript(session: SessionState): { filename: string; script: string } {
  const safeName = (session.prompt || "miru-session")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "miru-session";
  const steps = session.workflowSteps ?? [];
  const commandBody = steps
    .map((step) => `  // ${step.title}\n  ${actionToScript(step.action)}`)
    .join("\n\n");

  const script = `/**
 * Miru exported workflow scaffold
 * Prompt: ${session.prompt || DEFAULT_PROMPT}
 * Generated: ${new Date().toISOString()}
 */

async function runMiruWorkflow({ query, click, type, scroll, wait, extract }) {
${commandBody || "  // No workflow steps were recorded yet."}
}

export { runMiruWorkflow };
`;

  return {
    filename: `${safeName}.js`,
    script,
  };
}

function getOrCreateRecording(session: SessionState): RecordedSession {
  return (
    session.recordedSession ?? {
      id: crypto.randomUUID(),
      prompt: session.prompt,
      mode: session.mode,
      workflowSteps: session.workflowSteps ?? [],
      startedAt: Date.now(),
    }
  );
}

async function getStoredSession(): Promise<SessionState> {
  const result = await chrome.storage.session.get(SESSION_STORAGE_KEY);
  return (result[SESSION_STORAGE_KEY] as SessionState | undefined) ?? createEmptySession();
}

async function saveSession(session: SessionState): Promise<SessionState> {
  const nextSession: SessionState = {
    ...session,
    history: session.history.slice(-MAX_HISTORY_ITEMS),
    workflowSteps: (session.workflowSteps ?? []).slice(-50),
    chatMessages: (session.chatMessages ?? []).slice(-30),
    updatedAt: Date.now(),
  };

  await chrome.storage.session.set({ [SESSION_STORAGE_KEY]: nextSession });
  return nextSession;
}

async function clearSession(): Promise<void> {
  await chrome.storage.session.remove(SESSION_STORAGE_KEY);
}

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.windowId) {
    throw new Error("No active browser tab found.");
  }

  return tab;
}

async function ensureContentScriptInjected(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "PING",
      source: MESSAGE_SOURCE,
    } as Message);
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/contentScript.js"],
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}

async function capturePageContext(tab: chrome.tabs.Tab): Promise<PageContext> {
  if (!tab.id || !tab.windowId) {
    throw new Error("Active tab is missing required identifiers.");
  }

  await ensureContentScriptInjected(tab.id);

  const response = (await chrome.tabs.sendMessage(tab.id, {
    type: "GET_PAGE_CONTEXT",
    source: MESSAGE_SOURCE,
  } as Message)) as ActionResultMessage | ErrorMessage;

  if (response.type === "ERROR") {
    throw new Error(response.error || "Failed to read page context.");
  }

  if (!response.payload.success) {
    throw new Error(response.payload.error || "Failed to read page context.");
  }

  const context = response.payload.result as PageContext;
  let screenshotDataUrl: string | undefined;

  try {
    screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "jpeg",
      quality: SCREENSHOT_QUALITY,
    });
  } catch (error) {
    console.warn("[Miru] Screenshot capture failed:", error);
  }

  return {
    ...context,
    screenshotDataUrl,
  };
}

function shouldAutoExecute(mode: MiruMode, action: ProposedAction): boolean {
  if (mode === "interactive") {
    return false;
  }

  if (mode === "ask") {
    return action.risk === "low" && !action.requiresConfirmation;
  }

  return !action.requiresConfirmation || action.risk !== "high";
}

async function executeAction(tabId: number, action: MiruAction): Promise<ActionResultPayload> {
  const response = (await chrome.tabs.sendMessage(tabId, {
    type: "EXECUTE_ACTION",
    source: MESSAGE_SOURCE,
    payload: action,
  } as Message)) as ActionResultMessage | ErrorMessage;

  if (response.type === "ERROR") {
    return {
      success: false,
      error: response.error,
    };
  }

  return response.payload;
}

async function updateSessionContext(session: SessionState, title = "Context refreshed"): Promise<SessionState> {
  const tab = await getActiveTab();
  const context = await capturePageContext(tab);

  let nextSession: SessionState = {
    ...session,
    tabId: tab.id,
    origin: new URL(tab.url || context.url).origin,
    currentContext: context,
    history: [...session.history, makeEvent(title, context.title || context.url, "info")],
  };

  if (!(session.chatMessages ?? []).some((message) => message.content.includes(context.url))) {
    nextSession = appendChatMessages(
      nextSession,
      createChatMessage("assistant", `I can see ${context.url}. I now have live DOM and screenshot context.`, "complete")
    );
  }

  return saveSession(nextSession);
}

async function planForSession(session: SessionState): Promise<SessionState> {
  if (!session.currentContext) {
    throw new Error("No page context is available yet.");
  }

  const plannerRequest: PlannerRequest = {
    sessionId: session.id ?? undefined,
    prompt: session.prompt,
    mode: session.mode,
    context: session.currentContext,
    history: session.history,
    chatMessages: session.chatMessages,
    workflowSteps: session.workflowSteps,
    routine: session.activeRoutine,
  };
  const streamMessageId = crypto.randomUUID();
  let streamingSession = await saveSession(
    appendChatMessages(
      {
        ...session,
        status: "planning",
      },
      {
        id: streamMessageId,
        role: "assistant",
        content: "",
        status: "thinking",
        createdAt: Date.now(),
      }
    )
  );
  broadcastStreamEvent({
    type: "assistant_message_start",
    messageId: streamMessageId,
    sessionId: streamingSession.id ?? undefined,
    createdAt: Date.now(),
  });

  let lastTokenFlushAt = Date.now();
  const { sessionId, proposedAction } = await fetchNextActionStream(plannerRequest, async (event) => {
    if (event.type === "assistant_message_start") {
      return;
    }

    if (event.type === "assistant_token") {
      streamingSession = appendTokenToMessage(streamingSession, streamMessageId, event.token, "thinking");
      const now = Date.now();
      if (now - lastTokenFlushAt > 45) {
        streamingSession = await saveSession(streamingSession);
        lastTokenFlushAt = now;
      }
      broadcastStreamEvent({
        ...event,
        messageId: streamMessageId,
      });
      return;
    }

    if (event.type === "assistant_message_done") {
      streamingSession = setMessageStatus(streamingSession, streamMessageId, "complete");
      streamingSession = await saveSession(streamingSession);
      broadcastStreamEvent({
        ...event,
        messageId: streamMessageId,
      });
      return;
    }

    streamingSession = setMessageStatus(streamingSession, streamMessageId, "error", event.error);
    streamingSession = await saveSession(streamingSession);
    broadcastStreamEvent({
      ...event,
      messageId: streamMessageId,
    });
  });
  streamingSession = setMessageStatus(streamingSession, streamMessageId, "complete");
  streamingSession = await saveSession(streamingSession);

  const workflowStep: WorkflowStep = {
    id: proposedAction.id,
    action: proposedAction.action,
    title: proposedAction.action.type === "EXTRACT" ? "Extract data" : proposedAction.action.type,
    rationale: proposedAction.rationale,
    status: shouldAutoExecute(session.mode, proposedAction) ? "running" : "planned",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const plannedSession = appendChatMessages(
    {
      ...streamingSession,
      id: sessionId,
      pendingAction: proposedAction,
      workflowSteps: [...(streamingSession.workflowSteps ?? []), workflowStep],
      status: shouldAutoExecute(streamingSession.mode, proposedAction) ? "executing" : "awaiting_approval",
      history: [
        ...streamingSession.history,
        makeEvent(
          "Next action ready",
          proposedAction.rationale,
          proposedAction.requiresConfirmation ? "warning" : "info"
        ),
      ],
    }
  );

  return saveSession(plannedSession);
}

async function executePendingAction(session: SessionState): Promise<SessionState> {
  if (!session.pendingAction) {
    throw new Error("There is no pending action to execute.");
  }

  if (!session.tabId) {
    throw new Error("Miru session is not attached to an active tab.");
  }

  const action = session.pendingAction;
  let workingSession = await saveSession(
    appendChatMessages(
      {
        ...session,
        workflowSteps: updateStepStatus(session.workflowSteps, action.id, "running"),
      },
      createChatMessage("assistant", `Running ${action.action.type.toLowerCase()} on the page.`, "running", action.id)
    )
  );
  const result = await executeAction(session.tabId, action.action);
  const eventStatus = result.success ? "success" : "error";
  let nextSession = await saveSession({
    ...workingSession,
    lastResult: result,
    lastError: result.success ? undefined : result.error,
    pendingAction: undefined,
    status: result.success ? "ready" : "error",
    workflowSteps: updateStepStatus(
      workingSession.workflowSteps,
      action.id,
      result.success ? "succeeded" : "failed",
      JSON.stringify(result.result ?? result.error ?? action.action)
    ),
    history: [
      ...workingSession.history,
      makeEvent(
        result.success ? "Action executed" : "Action failed",
        JSON.stringify(result.result ?? result.error ?? action.action),
        eventStatus
      ),
    ],
  });

  nextSession = appendChatMessages(
    nextSession,
    createChatMessage(
      "assistant",
      result.success
        ? `Done. ${JSON.stringify(result.result ?? {})}`
        : `That step failed: ${result.error || "Unknown error"}`,
      result.success ? "complete" : "error",
      action.id
    )
  );

  if (nextSession.isRecording) {
    nextSession.recordedSession = {
      ...getOrCreateRecording(nextSession),
      prompt: nextSession.prompt,
      mode: nextSession.mode,
      workflowSteps: nextSession.workflowSteps ?? [],
    };
  }

  if (result.success && action.action.type !== "STOP") {
    nextSession = await updateSessionContext(nextSession, "Context refreshed after action");
  }

  return nextSession;
}

async function startSession(payload: StartSessionPayload): Promise<SessionState> {
  const tab = await getActiveTab();
  const baseSession = appendChatMessages(
    {
      ...(await saveSession({
        id: crypto.randomUUID(),
        mode: payload.mode,
        prompt: payload.prompt.trim() || DEFAULT_PROMPT,
        status: "capturing",
        tabId: tab.id,
        origin: tab.url ? new URL(tab.url).origin : undefined,
        history: [makeEvent("Session started", `Mode: ${payload.mode}`, "info")],
        workflowSteps: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })),
      chatMessages: [],
      recordedSession: undefined,
      lastExportedScript: undefined,
    },
    createChatMessage("user", payload.prompt.trim() || DEFAULT_PROMPT, "complete")
  );
  const storedBase = await saveSession({
    ...baseSession,
    id: crypto.randomUUID(),
  });

  let session = await updateSessionContext(storedBase, "Initial page context captured");
  session = await saveSession({ ...session, status: "planning" });
  session = await planForSession(session);

  if (session.pendingAction && shouldAutoExecute(session.mode, session.pendingAction)) {
    session = await executePendingAction(session);
  }

  return session;
}

async function getSessionResponse(): Promise<SessionResponseMessage> {
  return {
    type: "SESSION_RESPONSE",
    payload: await getStoredSession(),
  };
}

chrome.runtime.onMessage.addListener(
  (
    message: Message,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: Message) => void
  ) => {
    const respondWithSession = async (work: () => Promise<SessionState | void>): Promise<void> => {
      try {
        await work();
        sendResponse(await getSessionResponse());
      } catch (error) {
        const session = await saveSession({
          ...(await getStoredSession()),
          status: "error",
          lastError: error instanceof Error ? error.message : "Unknown Miru error.",
          history: [
            ...(await getStoredSession()).history,
            makeEvent(
              "Session error",
              error instanceof Error ? error.message : "Unknown Miru error.",
              "error"
            ),
          ],
        });

        sendResponse({
          type: "SESSION_RESPONSE",
          payload: session,
        });
      }
    };

    if (message.type === "GET_SESSION") {
      void getSessionResponse().then((response) => sendResponse(response));
      return true;
    }

    if (message.type === "START_SESSION") {
      void respondWithSession(async () => {
        await startSession(message.payload as StartSessionPayload);
      });
      return true;
    }

    if (message.type === "PLAN_NEXT_ACTION") {
      void respondWithSession(async () => {
        const session = await saveSession({ ...(await getStoredSession()), status: "planning" });
        const planned = await planForSession(session);
        if (planned.pendingAction && shouldAutoExecute(planned.mode, planned.pendingAction)) {
          await executePendingAction(planned);
        }
      });
      return true;
    }

    if (message.type === "REFRESH_CONTEXT") {
      void respondWithSession(async () => {
        const session = await saveSession({ ...(await getStoredSession()), status: "capturing" });
        await updateSessionContext(session);
      });
      return true;
    }

    if (message.type === "TOGGLE_RECORDING") {
      void respondWithSession(async () => {
        const current = await getStoredSession();
        const isRecording = !current.isRecording;
        const next = appendChatMessages(
          {
            ...current,
            isRecording,
            recordedSession: isRecording
              ? getOrCreateRecording(current)
              : current.recordedSession
                ? {
                    ...current.recordedSession,
                    workflowSteps: current.workflowSteps ?? [],
                    completedAt: Date.now(),
                  }
                : undefined,
          },
          createChatMessage(
            "system",
            isRecording
              ? "Recording started. This session can be exported as JavaScript."
              : "Recording stopped. You can now export the recorded workflow.",
            "complete"
          )
        );
        await saveSession(next);
      });
      return true;
    }

    if (message.type === "EXPORT_SESSION_SCRIPT") {
      void (async () => {
        const session = await getStoredSession();
        const exported = buildExportedScript(session);
        await saveSession({
          ...session,
          lastExportedScript: exported.script,
          recordedSession: session.recordedSession
            ? {
                ...session.recordedSession,
                workflowSteps: session.workflowSteps ?? [],
                completedAt: Date.now(),
              }
            : session.recordedSession,
        });
        sendResponse({
          type: "EXPORT_SCRIPT_RESPONSE",
          payload: exported,
        } as ExportScriptResponseMessage);
      })();
      return true;
    }

    if (message.type === "APPROVE_PENDING_ACTION") {
      void respondWithSession(async () => {
        const session = await saveSession({ ...(await getStoredSession()), status: "executing" });
        await executePendingAction(session);
      });
      return true;
    }

    if (message.type === "STOP_SESSION") {
      void (async () => {
        await clearSession();
        sendResponse(await getSessionResponse());
      })();
      return true;
    }

    return false;
  }
);

console.log("[Miru] Service worker initialized");
