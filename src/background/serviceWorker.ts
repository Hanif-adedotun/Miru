/**
 * Background service worker for Miru
 * Orchestrates session state, page capture, planning, and constrained execution
 */

import { fetchNextActionStream } from "./plannerClient.js";
import {
  capturePageContext,
  clearPageOverlay,
  executeActionOnTab,
  getActiveTab,
  syncPageOverlay,
} from "./browserOps.js";
import {
  answerRunAsk,
  approveRunStep,
  cancelRun,
  initRunGateway,
  resetSession,
  isActiveRunInProgress,
  resumeRunIfNeeded,
  shouldDeferNavigationRefresh,
  startRun,
} from "./runGateway.js";
import {
  clearSession,
  createEmptySession,
  getStoredSession,
  saveSession,
} from "./sessionStore.js";
import { broadcastStreamEvent, registerStreamPort } from "./streamHub.js";
import { MIRU_USE_WS_RUNS } from "../generated/runtime-config.js";
import {
  DEFAULT_PROMPT,
  MESSAGE_SOURCE,
} from "../shared/constants.js";
import {
  AUTO_OVERLAY_BANNER,
  type PageAutomationOverlayPayload,
} from "../shared/overlay.js";
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
  PendingAsk,
  PlannerStreamEvent,
  ProposedAction,
  PlannerRequest,
  RecordedSession,
  RespondToAskPayload,
  ScrapeArtifact,
  SessionEvent,
  SessionResponseMessage,
  SessionState,
  SessionStatus,
  PlanNextActionPayload,
  StartSessionPayload,
  WorkflowStep,
  WorkflowStepStatus,
} from "../shared/types.js";

const MAX_SCRAPE_ARTIFACTS = 40;
const MAX_ROWS_PER_SCRAPE_ARTIFACT = 1500;

/** Max plan→execute cycles per user send across any mode (avoids infinite loops). */
const AUTO_CHAIN_MAX_STEPS = 25;

void chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error("[Miru] Failed to enable side panel action behavior:", error));

chrome.runtime.onConnect.addListener((port) => {
  registerStreamPort(port);
});

if (MIRU_USE_WS_RUNS) {
  initRunGateway();
}

/**
 * Statuses during which the SW is mid-cycle and a background refresh would race
 * with planForSession / executePendingAction. We only auto-refresh when the
 * session is at rest.
 */
const BACKGROUND_REFRESH_BUSY_STATUSES: ReadonlySet<SessionStatus> = new Set([
  "capturing",
  "planning",
  "executing",
]);

/**
 * In-memory lock so two near-simultaneous `tabs.onUpdated` events (loading then
 * complete, or two SPA route changes) don't pile up overlapping DOM captures.
 */
let backgroundRefreshInFlight = false;

/**
 * Auto-refresh `currentContext` when the bound tab finishes navigating, so the
 * UI banner reflects what Miru actually sees without the user having to send a
 * new prompt. Skips when the session is busy, when no URL change occurred, and
 * when an auto-refresh is already running.
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") {
    return;
  }
  if (!tab?.url || (!tab.url.startsWith("http://") && !tab.url.startsWith("https://"))) {
    return;
  }

  void (async () => {
    if (backgroundRefreshInFlight) {
      return;
    }

    const session = await getStoredSession();
    if (!session.id || session.tabId !== tabId) {
      return;
    }
    if (MIRU_USE_WS_RUNS && (shouldDeferNavigationRefresh() || (await isActiveRunInProgress()))) {
      return;
    }
    if (BACKGROUND_REFRESH_BUSY_STATUSES.has(session.status)) {
      return;
    }
    if (session.pendingAction || session.pendingAsk) {
      // Don't clobber an in-flight plan or pending ask with a navigation
      // refresh; the user is mid-decision.
      return;
    }
    if (session.currentContext?.url === tab.url) {
      return;
    }

    backgroundRefreshInFlight = true;
    try {
      console.log(`[Miru] auto-refresh on navigation: ${tab.url}`);
      const capturing = await saveSession({ ...session, status: "capturing" });
      const refreshed = await updateSessionContext(capturing, "Tab navigated", {
        tab,
        silent: true,
        silentHistory: false,
      });
      // updateSessionContext leaves status untouched; restore to "ready" so
      // the UI doesn't appear permanently "capturing" after the refresh.
      await saveSession({ ...refreshed, status: "ready" });
    } catch (error) {
      console.warn("[Miru] Background context refresh failed:", error);
      // Best-effort: clear the "capturing" status so the UI doesn't hang.
      try {
        const recovered = await getStoredSession();
        if (recovered.status === "capturing") {
          await saveSession({ ...recovered, status: "ready" });
        }
      } catch {
        // ignore
      }
    } finally {
      backgroundRefreshInFlight = false;
    }
  })();
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
  resultSummary?: string,
  resultData?: unknown
): WorkflowStep[] {
  return (workflowSteps ?? []).map((step) =>
    step.id === stepId
      ? {
          ...step,
          status,
          resultSummary: resultSummary ?? step.resultSummary,
          ...(resultData !== undefined ? { resultData } : {}),
          updatedAt: Date.now(),
        }
      : step
  );
}

function normalizeRowStrings(row: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = value === null || value === undefined ? "" : String(value);
  }
  return out;
}

function buildScrapeArtifact(stepId: string, action: MiruAction, result: unknown): ScrapeArtifact | null {
  if (action.type === "QUERY") {
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      return null;
    }

    const row = normalizeRowStrings(result as Record<string, unknown>);
    const columns = ["selector", "label", "tagName", "role"].filter((key) =>
      Object.prototype.hasOwnProperty.call(row, key)
    );
    if (columns.length === 0) {
      return null;
    }

    const orderedRow: Record<string, string> = {};
    for (const column of columns) {
      orderedRow[column] = row[column] ?? "";
    }

    return {
      id: crypto.randomUUID(),
      stepId,
      createdAt: Date.now(),
      source: "QUERY",
      label: `QUERY: ${action.selector}`,
      columns,
      rows: [orderedRow],
    };
  }

  if (action.type === "EXTRACT") {
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      return null;
    }

    const row = normalizeRowStrings(result as Record<string, unknown>);
    const fromFields = action.fields
      .map((field) => field.name)
      .filter((name) => Object.prototype.hasOwnProperty.call(row, name));
    const columns = fromFields.length > 0 ? fromFields : Object.keys(row);
    if (columns.length === 0) {
      return null;
    }

    const orderedRow: Record<string, string> = {};
    for (const column of columns) {
      orderedRow[column] = row[column] ?? "";
    }

    return {
      id: crypto.randomUUID(),
      stepId,
      createdAt: Date.now(),
      source: "EXTRACT",
      label: `EXTRACT: ${action.fields.map((field) => field.name).join(", ")}`,
      columns,
      rows: [orderedRow],
    };
  }

  if (action.type === "EXTRACT_LIST") {
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      return null;
    }

    const rowsRaw = (result as { rows?: unknown }).rows;
    if (!Array.isArray(rowsRaw) || rowsRaw.length === 0) {
      return null;
    }

    const rows = rowsRaw
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
      .map(normalizeRowStrings);
    const columnOrder = action.fields.map((field) => field.name);
    if (columnOrder.length === 0 || rows.length === 0) {
      return null;
    }

    const normalizedRows = rows.map((row) => {
      const ordered: Record<string, string> = {};
      for (const column of columnOrder) {
        ordered[column] = row[column] ?? "";
      }
      return ordered;
    });

    return {
      id: crypto.randomUUID(),
      stepId,
      createdAt: Date.now(),
      source: "EXTRACT_LIST",
      label: `EXTRACT_LIST: ${action.itemSelector} (${normalizedRows.length} rows)`,
      columns: columnOrder,
      rows: normalizedRows,
    };
  }

  return null;
}

function trimScrapeArtifacts(artifacts: ScrapeArtifact[] | undefined): ScrapeArtifact[] | undefined {
  if (!artifacts || artifacts.length === 0) {
    return artifacts;
  }

  return artifacts.slice(-MAX_SCRAPE_ARTIFACTS).map((artifact) => ({
    ...artifact,
    columns: artifact.columns.slice(0, 64),
    rows: artifact.rows.slice(0, MAX_ROWS_PER_SCRAPE_ARTIFACT),
  }));
}

function workflowStepTitle(action: MiruAction): string {
  if (action.type === "EXTRACT") {
    return "Extract data";
  }
  if (action.type === "EXTRACT_LIST") {
    return "Extract list";
  }
  if (action.type === "ASK_USER") {
    return "Ask user";
  }
  return action.type;
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
  const prior = next[index].content.trim();
  const nextContent =
    fallback && prior ? `${next[index].content}\n${fallback}` : fallback && !prior ? fallback : next[index].content;
  next[index] = {
    ...next[index],
    status,
    content: nextContent,
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
    case "EXTRACT_LIST":
      return `await extractList(${JSON.stringify(action.itemSelector)}, ${JSON.stringify(action.fields, null, 2)}, ${JSON.stringify(action.maxItems ?? null)});`;
    case "ASK_USER":
      return `// askUser(${JSON.stringify(action.question)}, ${JSON.stringify(action.options ?? [])});`;
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

async function runMiruWorkflow({ query, click, type, scroll, wait, extract, extractList }) {
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

async function clearAutoPageOverlay(tabId: number | undefined): Promise<void> {
  await clearPageOverlay(tabId);
}

async function updateAutoPageOverlay(
  tabId: number | undefined,
  mode: MiruMode,
  update: Omit<PageAutomationOverlayPayload, "active" | "message"> & {
    active?: boolean;
    message?: string;
  }
): Promise<void> {
  if (!tabId) {
    return;
  }

  if (update.active === false) {
    await clearPageOverlay(tabId);
    return;
  }

  await syncPageOverlay(tabId, {
    active: true,
    message: AUTO_OVERLAY_BANNER,
    ...update,
  });
}

function shouldAutoExecute(mode: MiruMode, action: ProposedAction): boolean {
  if (action.action.type === "ASK_USER") {
    return false;
  }

  if (mode === "interactive") {
    return false;
  }

  if (mode === "ask") {
    return action.risk === "low" && !action.requiresConfirmation;
  }

  return true;
}

/**
 * Decide whether the SW should keep planning the *next* step on its own.
 *
 * This is the orthogonal gate to `shouldAutoExecute`: execution decides whether
 * we may run an already-planned action without user confirmation; continuation
 * decides whether we may re-enter `planForSession` after a step finished.
 *
 * Across every mode we want the loop to keep moving so the user does not have
 * to send a new prompt after every single step — the per-iteration approval
 * gate (`shouldAutoExecute`) is what holds back risky actions in ask /
 * interactive modes.
 */
function shouldAutoContinue(
  mode: MiruMode,
  status: SessionStatus,
  lastAction: MiruAction | undefined
): boolean {
  if (status !== "ready") {
    return false;
  }

  if (lastAction?.type === "STOP") {
    return false;
  }

  return mode === "auto" || mode === "ask" || mode === "interactive";
}

function lastWorkflowStep(session: SessionState): WorkflowStep | undefined {
  const steps = session.workflowSteps ?? [];
  return steps[steps.length - 1];
}

/**
 * Route an ASK_USER pending action: it never goes to the page. Mark the step as
 * skipped (pending answer), clear pendingAction, surface pendingAsk so the UI
 * can prompt the user. The next message from the user resumes planning.
 */
async function routeAskUser(session: SessionState): Promise<SessionState> {
  const action = session.pendingAction;
  if (!action || action.action.type !== "ASK_USER") {
    return session;
  }

  const ask: PendingAsk = {
    stepId: action.id,
    question: action.action.question,
    options: action.action.options,
    createdAt: Date.now(),
  };

  await clearAutoPageOverlay(session.tabId);

  let next: SessionState = {
    ...session,
    status: "awaiting_input",
    pendingAction: undefined,
    pendingAsk: ask,
    workflowSteps: updateStepStatus(
      session.workflowSteps,
      action.id,
      "skipped",
      ask.question,
      ask
    ),
    history: [
      ...session.history,
      makeEvent("Miru needs input", ask.question, "warning"),
    ],
  };

  next = appendChatMessages(
    next,
    createChatMessage("assistant", ask.question, "complete", action.id)
  );

  return saveSession(next);
}

/**
 * After a successful action, keep planning and executing until one of:
 *   - the planner returns STOP,
 *   - the planner returns ASK_USER (routed to `awaiting_input`),
 *   - the next planned action is not auto-executable in the current mode
 *     (sets `awaiting_approval`; the user resumes the chain by approving),
 *   - executePendingAction errors,
 *   - the step cap is hit.
 *
 * This loop is intentionally mode-agnostic: ask / interactive modes also chain,
 * stopping at each step that needs approval rather than after the very first
 * step. The per-step `shouldAutoExecute` gate is what enforces the
 * mode-specific approval policy.
 */
async function runWorkflowContinuation(session: SessionState): Promise<SessionState> {
  const initialLast = lastWorkflowStep(session);
  if (!shouldAutoContinue(session.mode, session.status, initialLast?.action)) {
    console.log(
      `[Miru] chain skipped entry mode=${session.mode} status=${session.status} lastAction=${initialLast?.action.type ?? "none"}`
    );
    return session;
  }

  let current = session;

  for (let i = 0; i < AUTO_CHAIN_MAX_STEPS; i++) {
    current = await saveSession({ ...current, status: "planning" });
    current = await planForSession(current);
    const plannedAction = current.pendingAction?.action.type ?? "none";
    console.log(
      `[Miru] chain iter=${i} mode=${current.mode} planStatus=${current.status} action=${plannedAction}`
    );

    if (current.status === "error" || !current.pendingAction) {
      return current;
    }

    if (current.pendingAction.action.type === "ASK_USER") {
      current = await routeAskUser(current);
      return current;
    }

    if (!shouldAutoExecute(current.mode, current.pendingAction)) {
      // Next step needs approval in this mode; stop here and let the user
      // approve. The approval handler re-enters runWorkflowContinuation.
      console.log(
        `[Miru] chain iter=${i} pausing for approval (action=${plannedAction})`
      );
      await clearAutoPageOverlay(current.tabId);
      // Surface a one-line system pill so the user sees *why* the chain
      // paused, even if the state strip is scrolled out of view.
      current = appendChatMessages(
        current,
        createChatMessage(
          "system",
          `Paused for approval before ${plannedAction.toLowerCase()}. Press Approve above to continue.`,
          "complete"
        )
      );
      return saveSession(current);
    }

    current = await executePendingAction(current);
    const executedAction = lastWorkflowStep(current);
    console.log(
      `[Miru] chain iter=${i} execStatus=${current.status} ranAction=${executedAction?.action.type ?? "none"} stepStatus=${executedAction?.status ?? "n/a"}`
    );

    if (current.status === "error") {
      await clearAutoPageOverlay(current.tabId);
      return current;
    }

    if (executedAction?.status === "succeeded" && executedAction.action.type === "STOP") {
      await clearAutoPageOverlay(current.tabId);
      return current;
    }

    if (!shouldAutoContinue(current.mode, current.status, executedAction?.action)) {
      console.log(
        `[Miru] chain iter=${i} exiting after exec — mode=${current.mode} status=${current.status} lastAction=${executedAction?.action.type ?? "none"}`
      );
      await clearAutoPageOverlay(current.tabId);
      return current;
    }
  }

  console.log(`[Miru] chain hit step cap of ${AUTO_CHAIN_MAX_STEPS}`);
  await clearAutoPageOverlay(current.tabId);

  return appendChatMessages(
    await saveSession({
      ...current,
      history: [
        ...current.history,
        makeEvent(
          "Chain limit",
          `Stopped after ${AUTO_CHAIN_MAX_STEPS} chained actions. Send another message to continue.`,
          "warning"
        ),
      ],
    }),
    createChatMessage(
      "system",
      `Paused after ${AUTO_CHAIN_MAX_STEPS} steps in one run. Send a message to continue.`,
      "complete"
    )
  );
}

interface UpdateContextOptions {
  /** When provided, capture from this specific tab instead of querying for the active tab. */
  tab?: chrome.tabs.Tab;
  /** Suppress the "I can see <url>" chat message — used for background auto-refresh. */
  silent?: boolean;
  /** Suppress the history event line too — useful for cheap re-captures. */
  silentHistory?: boolean;
}

async function updateSessionContext(
  session: SessionState,
  title = "Context refreshed",
  options: UpdateContextOptions = {}
): Promise<SessionState> {
  const tab = options.tab ?? (await getActiveTab());
  const context = await capturePageContext(tab);

  let nextSession: SessionState = {
    ...session,
    tabId: tab.id,
    origin: new URL(tab.url || context.url).origin,
    currentContext: context,
    history: options.silentHistory
      ? session.history
      : [...session.history, makeEvent(title, context.title || context.url, "info")],
  };

  if (
    !options.silent &&
    !(session.chatMessages ?? []).some((message) => message.content.includes(context.url))
  ) {
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
  await updateAutoPageOverlay(session.tabId, session.mode, { phase: "planning" });

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

  try {
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

    const isAsk = proposedAction.action.type === "ASK_USER";
    const willAutoRun = !isAsk && shouldAutoExecute(streamingSession.mode, proposedAction);
    const nextStatus: SessionState["status"] = isAsk
      ? "awaiting_input"
      : willAutoRun
        ? "executing"
        : "awaiting_approval";
    const workflowStep: WorkflowStep = {
      id: proposedAction.id,
      action: proposedAction.action,
      title: workflowStepTitle(proposedAction.action),
      rationale: proposedAction.rationale,
      status: willAutoRun ? "running" : "planned",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const plannedSession = appendChatMessages(
      {
        ...streamingSession,
        id: sessionId,
        pendingAction: proposedAction,
        workflowSteps: [...(streamingSession.workflowSteps ?? []), workflowStep],
        status: nextStatus,
        history: [
          ...streamingSession.history,
          makeEvent(
            isAsk ? "Miru needs input" : "Next action ready",
            proposedAction.rationale,
            proposedAction.requiresConfirmation || isAsk ? "warning" : "info"
          ),
        ],
      }
    );

    const saved = await saveSession(plannedSession);
    if (isAsk || !willAutoRun) {
      await clearAutoPageOverlay(saved.tabId);
    } else {
      await updateAutoPageOverlay(saved.tabId, saved.mode, {
        phase: "preview",
        action: proposedAction.action,
        rationale: proposedAction.rationale,
      });
    }
    return saved;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Planning failed.";
    const cur = (streamingSession.chatMessages ?? []).find((item) => item.id === streamMessageId);
    if (cur?.status === "thinking") {
      streamingSession = setMessageStatus(streamingSession, streamMessageId, "error", message);
      broadcastStreamEvent({
        type: "assistant_message_error",
        messageId: streamMessageId,
        error: message,
        createdAt: Date.now(),
      });
    }

    const failed = await saveSession({
      ...streamingSession,
      status: "error",
      lastError: message,
      history: [...streamingSession.history, makeEvent("Planning failed", message, "error")],
    });
    await clearAutoPageOverlay(failed.tabId);
    return failed;
  }
}

async function executePendingAction(session: SessionState): Promise<SessionState> {
  if (!session.pendingAction) {
    throw new Error("There is no pending action to execute.");
  }

  if (!session.tabId) {
    throw new Error("Miru session is not attached to an active tab.");
  }

  const action = session.pendingAction;
  await updateAutoPageOverlay(session.tabId, session.mode, {
    phase: "executing",
    action: action.action,
    rationale: action.rationale,
  });

  let workingSession = await saveSession(
    appendChatMessages(
      {
        ...session,
        workflowSteps: updateStepStatus(session.workflowSteps, action.id, "running"),
      },
      createChatMessage("assistant", `Running ${action.action.type.toLowerCase()} on the page.`, "running", action.id)
    )
  );
  const result = await executeActionOnTab(session.tabId, action.action);
  const eventStatus = result.success ? "success" : "error";
  const artifact =
    result.success ? buildScrapeArtifact(action.id, action.action, result.result) : null;
  const scrapeArtifacts = artifact
    ? [...(workingSession.scrapeArtifacts ?? []), artifact]
    : (workingSession.scrapeArtifacts ?? []);

  let nextSession = await saveSession({
    ...workingSession,
    lastResult: result,
    lastError: result.success ? undefined : result.error,
    pendingAction: undefined,
    status: result.success ? "ready" : "error",
    scrapeArtifacts,
    workflowSteps: updateStepStatus(
      workingSession.workflowSteps,
      action.id,
      result.success ? "succeeded" : "failed",
      JSON.stringify(result.result ?? result.error ?? action.action),
      result.success ? result.result : undefined
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

  if (!result.success || nextSession.status === "error" || action.action.type === "STOP") {
    await clearAutoPageOverlay(nextSession.tabId);
  }

  return nextSession;
}

async function startSession(payload: StartSessionPayload): Promise<SessionState> {
  if (MIRU_USE_WS_RUNS) {
    return startRun(payload);
  }

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
        scrapeArtifacts: [],
        pendingAsk: undefined,
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

  if (session.status !== "error" && session.pendingAction) {
    if (session.pendingAction.action.type === "ASK_USER") {
      session = await routeAskUser(session);
    } else if (shouldAutoExecute(session.mode, session.pendingAction)) {
      session = await executePendingAction(session);
      session = await runWorkflowContinuation(session);
    }
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

    if (message.type === "SYNC_PANEL_OPEN") {
      void respondWithSession(async () => {
        let session = await getStoredSession();
        if (!session.id) {
          return;
        }

        const tab = await getActiveTab();
        session = await saveSession({
          ...session,
          tabId: tab.id,
          origin: tab.url ? new URL(tab.url).origin : session.origin,
          status: "capturing",
        });
        const refreshed = await updateSessionContext(session, "Panel opened", {
          tab,
          silent: true,
          silentHistory: true,
        });
        // Restore a resting status unless the session was mid-gate.
        const restingStatus: SessionState["status"] =
          refreshed.status === "awaiting_approval" ||
          refreshed.status === "awaiting_input" ||
          refreshed.status === "error"
            ? refreshed.status
            : "ready";
        await saveSession({ ...refreshed, status: restingStatus });
      });
      return true;
    }

    if (message.type === "START_SESSION" || message.type === "START_RUN") {
      void respondWithSession(async () => {
        await startSession(message.payload as StartSessionPayload);
      });
      return true;
    }

    if (message.type === "APPROVE_RUN_STEP") {
      void respondWithSession(async () => {
        const payload = (message.payload ?? {}) as { stepId: string };
        await approveRunStep(payload.stepId);
      });
      return true;
    }

    if (message.type === "ANSWER_RUN_ASK") {
      void respondWithSession(async () => {
        const payload = (message.payload ?? {}) as RespondToAskPayload;
        if (payload.answer?.trim()) {
          await answerRunAsk(payload.stepId, payload.answer.trim());
        }
      });
      return true;
    }

    if (message.type === "CANCEL_RUN") {
      void respondWithSession(async () => {
        await cancelRun();
      });
      return true;
    }

    if (message.type === "SYNC_RUN") {
      void respondWithSession(async () => {
        if (MIRU_USE_WS_RUNS) {
          const session = await getStoredSession();
          if (session.runId) {
            await resumeRunIfNeeded();
          }
        }
      });
      return true;
    }

    if (message.type === "PLAN_NEXT_ACTION") {
      void respondWithSession(async () => {
        const payload = (message.payload ?? {}) as PlanNextActionPayload;
        let session = await getStoredSession();

        if (MIRU_USE_WS_RUNS && payload.userMessage?.trim()) {
          const mode = payload.mode === "auto" || payload.mode === "ask" ? payload.mode : session.mode;
          if (session.runId) {
            await cancelRun();
          }
          await startRun({ prompt: payload.userMessage.trim(), mode });
          return;
        }

        if (payload.mode === "auto" || payload.mode === "ask") {
          session = { ...session, mode: payload.mode };
        }
        if (payload.userMessage?.trim()) {
          const text = payload.userMessage.trim();
          session = await saveSession(
            appendChatMessages(
              { ...session, prompt: text, pendingAsk: undefined },
              createChatMessage("user", text, "complete")
            )
          );
        }
        session = await saveSession({ ...session, status: "planning" });
        const planned = await planForSession(session);
        if (
          planned.status !== "error" &&
          planned.pendingAction
        ) {
          if (planned.pendingAction.action.type === "ASK_USER") {
            await routeAskUser(planned);
          } else if (shouldAutoExecute(planned.mode, planned.pendingAction)) {
            let after = await executePendingAction(planned);
            after = await runWorkflowContinuation(after);
            await saveSession(after);
          }
        }
      });
      return true;
    }

    if (message.type === "RESPOND_TO_ASK") {
      void respondWithSession(async () => {
        const payload = (message.payload ?? {}) as RespondToAskPayload;
        const answer = payload.answer?.trim();
        if (!answer) {
          return;
        }

        const existing = await getStoredSession();
        if (MIRU_USE_WS_RUNS && existing.runId) {
          await answerRunAsk(payload.stepId, answer);
          return;
        }

        let session = existing;
        session = await saveSession(
          appendChatMessages(
            {
              ...session,
              prompt: answer,
              pendingAsk: undefined,
              status: "planning",
            },
            createChatMessage("user", answer, "complete", payload.stepId)
          )
        );

        const planned = await planForSession(session);
        if (
          planned.status !== "error" &&
          planned.pendingAction
        ) {
          if (planned.pendingAction.action.type === "ASK_USER") {
            await routeAskUser(planned);
          } else if (shouldAutoExecute(planned.mode, planned.pendingAction)) {
            let after = await executePendingAction(planned);
            after = await runWorkflowContinuation(after);
            await saveSession(after);
          }
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
        const session = await getStoredSession();
        if (MIRU_USE_WS_RUNS && session.runId && session.pendingAction) {
          await approveRunStep(session.pendingAction.id);
          return;
        }
        const executing = await saveSession({ ...session, status: "executing" });
        let after = await executePendingAction(executing);
        after = await runWorkflowContinuation(after);
        await saveSession(after);
      });
      return true;
    }

    if (message.type === "STOP_SESSION") {
      void (async () => {
        if (MIRU_USE_WS_RUNS) {
          await resetSession();
        } else {
          const session = await getStoredSession();
          await clearPageOverlay(session.tabId);
          await clearSession();
        }
        sendResponse(await getSessionResponse());
      })();
      return true;
    }

    return false;
  }
);

console.log("[Miru] Service worker initialized");
