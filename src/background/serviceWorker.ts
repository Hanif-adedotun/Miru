/**
 * Background service worker for Miru
 * Orchestrates session state, page capture, planning, and constrained execution
 */

import { fetchNextAction } from "./plannerClient.js";
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
  ErrorMessage,
  Message,
  MiruAction,
  MiruMode,
  PageContext,
  ProposedAction,
  PlannerRequest,
  SessionEvent,
  SessionResponseMessage,
  SessionState,
  StartSessionPayload,
} from "../shared/types.js";

function createEmptySession(): SessionState {
  return {
    id: null,
    mode: "interactive",
    prompt: DEFAULT_PROMPT,
    status: "idle",
    history: [],
    updatedAt: Date.now(),
  };
}

void chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error("[Miru] Failed to enable side panel action behavior:", error));

function makeEvent(title: string, detail: string, status: SessionEvent["status"]): SessionEvent {
  return {
    id: crypto.randomUUID(),
    title,
    detail,
    status,
    createdAt: Date.now(),
  };
}

async function getStoredSession(): Promise<SessionState> {
  const result = await chrome.storage.session.get(SESSION_STORAGE_KEY);
  return (result[SESSION_STORAGE_KEY] as SessionState | undefined) ?? createEmptySession();
}

async function saveSession(session: SessionState): Promise<SessionState> {
  const nextSession: SessionState = {
    ...session,
    history: session.history.slice(-MAX_HISTORY_ITEMS),
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

  return saveSession({
    ...session,
    tabId: tab.id,
    origin: new URL(tab.url || context.url).origin,
    currentContext: context,
    history: [...session.history, makeEvent(title, context.title || context.url, "info")],
  });
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
  };

  const { sessionId, proposedAction } = await fetchNextAction(plannerRequest);

  return saveSession({
    ...session,
    id: sessionId,
    pendingAction: proposedAction,
    status: shouldAutoExecute(session.mode, proposedAction) ? "executing" : "awaiting_approval",
    history: [
      ...session.history,
      makeEvent(
        "Next action ready",
        proposedAction.rationale,
        proposedAction.requiresConfirmation ? "warning" : "info"
      ),
    ],
  });
}

async function executePendingAction(session: SessionState): Promise<SessionState> {
  if (!session.pendingAction) {
    throw new Error("There is no pending action to execute.");
  }

  if (!session.tabId) {
    throw new Error("Miru session is not attached to an active tab.");
  }

  const action = session.pendingAction;
  const result = await executeAction(session.tabId, action.action);
  const eventStatus = result.success ? "success" : "error";
  let nextSession = await saveSession({
    ...session,
    lastResult: result,
    lastError: result.success ? undefined : result.error,
    pendingAction: undefined,
    status: result.success ? "ready" : "error",
    history: [
      ...session.history,
      makeEvent(
        result.success ? "Action executed" : "Action failed",
        JSON.stringify(result.result ?? result.error ?? action.action),
        eventStatus
      ),
    ],
  });

  if (result.success && action.action.type !== "STOP") {
    nextSession = await updateSessionContext(nextSession, "Context refreshed after action");
  }

  return nextSession;
}

async function startSession(payload: StartSessionPayload): Promise<SessionState> {
  const tab = await getActiveTab();
  const baseSession = await saveSession({
    id: crypto.randomUUID(),
    mode: payload.mode,
    prompt: payload.prompt.trim() || DEFAULT_PROMPT,
    status: "capturing",
    tabId: tab.id,
    origin: tab.url ? new URL(tab.url).origin : undefined,
    history: [makeEvent("Session started", `Mode: ${payload.mode}`, "info")],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  let session = await updateSessionContext(baseSession, "Initial page context captured");
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
