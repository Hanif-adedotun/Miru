import { MIRU_USE_WS_RUNS } from "../generated/runtime-config.js";
import { DEFAULT_PROMPT, SESSION_STORAGE_KEY } from "../shared/constants.js";
import type { RunSessionSnapshot } from "../shared/run-protocol.js";
import type {
  ChatMessage,
  MiruAction,
  MiruMode,
  PendingAsk,
  PlannerStreamEvent,
  RunStreamEvent,
  SessionResponseMessage,
  SessionState,
  SessionStreamEventMessage,
  WorkflowStep,
} from "../shared/types.js";
import { downloadArtifactsCsv, downloadArtifactsPdf, exportBaseFilename } from "./exportDownloads.js";

const MODE_OPTIONS = ["auto", "ask"] as const satisfies readonly MiruMode[];

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function actionVerb(action: MiruAction): string {
  switch (action.type) {
    case "QUERY":
      return "Inspect";
    case "CLICK":
      return "Click";
    case "TYPE":
      return "Type";
    case "SCROLL":
      return "Scroll";
    case "WAIT":
      return "Wait";
    case "EXTRACT":
      return "Extract";
    case "EXTRACT_LIST":
      return "Extract list";
    case "ASK_USER":
      return "Ask";
    case "STOP":
      return "Stop";
    default:
      return "Step";
  }
}

function actionDetail(action: MiruAction): string {
  switch (action.type) {
    case "QUERY":
    case "CLICK":
      return action.selector;
    case "TYPE":
      return `${action.selector}  ←  ${action.text}`;
    case "SCROLL":
      return action.direction === "to"
        ? `to ${action.amount ?? 0}px`
        : `${action.direction}${action.amount ? ` · ${action.amount}px` : ""}`;
    case "WAIT":
      return `${action.durationMs}ms`;
    case "EXTRACT":
      return action.fields.map((field) => field.name).join(", ");
    case "EXTRACT_LIST":
      return `${action.itemSelector} → ${action.fields.map((field) => field.name).join(", ")}`;
    case "ASK_USER":
      return action.question;
    case "STOP":
      return action.reason;
    default:
      return "";
  }
}

function stepResultTail(step: WorkflowStep): string {
  if (step.status !== "succeeded") {
    return "";
  }

  const action = step.action;
  const data = step.resultData as unknown;
  if (action.type === "EXTRACT_LIST" && data && typeof data === "object" && "rows" in data) {
    const rows = (data as { rows?: unknown[] }).rows;
    const count = Array.isArray(rows) ? rows.length : 0;
    return `${count} row${count === 1 ? "" : "s"}`;
  }
  if (action.type === "EXTRACT") {
    return "1 row";
  }
  if (action.type === "QUERY") {
    return "matched";
  }
  if (action.type === "STOP") {
    return "done";
  }
  return "ok";
}

const iconAuto = `<svg class="mode-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>`;
const iconAsk = `<svg class="mode-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5l6.5 9-6.5 9-6.5-9 6.5-9z"/></svg>`;

function renderModePill(selectedMode: MiruMode): string {
  return MODE_OPTIONS.map((mode) => {
    const label = mode === "auto" ? "Auto" : "Ask";
    const active = selectedMode === mode;
    const icon = mode === "auto" ? iconAuto : iconAsk;
    return `<button type="button" class="mode-bubble ${active ? "is-active" : ""}" data-mode="${mode}">${icon}<span class="mode-bubble-label">${label}</span></button>`;
  }).join("");
}

type TimelineEntry =
  | { kind: "message"; createdAt: number; data: ChatMessage }
  | { kind: "step"; createdAt: number; data: WorkflowStep; index: number };

/**
 * Merge chat messages + workflow steps into a single ordered timeline. Step-tied
 * "Running …"/"Done …" assistant chat messages are dropped (the step row carries that signal).
 * Assistant messages tied to ASK_USER steps are preserved as clarification pills.
 */
function buildTimeline(state: SessionState): TimelineEntry[] {
  const steps = state.workflowSteps ?? [];
  const stepById = new Map<string, WorkflowStep>(steps.map((step) => [step.id, step]));
  const entries: TimelineEntry[] = [];

  for (const message of state.chatMessages ?? []) {
    const related = message.relatedStepId ? stepById.get(message.relatedStepId) : undefined;
    if (
      message.role === "assistant" &&
      related &&
      related.action.type !== "ASK_USER" &&
      message.id !== related.id
    ) {
      // Drop redundant "Running …" / "Done …" assistant pings; the step row shows status.
      continue;
    }
    entries.push({ kind: "message", createdAt: message.createdAt, data: message });
  }

  let stepIndex = 0;
  for (const step of steps) {
    stepIndex += 1;
    if (step.action.type === "ASK_USER") {
      continue;
    }
    entries.push({ kind: "step", createdAt: step.createdAt, data: step, index: stepIndex });
  }

  return entries.sort((a, b) => a.createdAt - b.createdAt);
}

function renderStepRow(entry: { data: WorkflowStep; index: number }): string {
  const step = entry.data;
  const status = step.status;
  const verb = actionVerb(step.action);
  const detail = actionDetail(step.action);
  const tail = stepResultTail(step);
  const kicker = `Step ${String(entry.index).padStart(2, "0")}`;
  return `
    <article class="timeline-entry entry-step status-${status}">
      <span class="step-dot" aria-hidden="true"></span>
      <div class="step-body">
        <div class="step-kicker">${escapeHtml(kicker)}</div>
        <div class="step-line">
          <span class="step-verb">${escapeHtml(verb)}</span>
          <code class="step-detail">${escapeHtml(detail)}</code>
        </div>
        ${tail ? `<div class="step-tail">${escapeHtml(tail)}</div>` : ""}
      </div>
    </article>
  `;
}

function renderClarificationPill(
  message: ChatMessage,
  pendingAsk: PendingAsk | undefined
): string {
  const isLive = pendingAsk && pendingAsk.stepId === message.relatedStepId;
  const options = isLive && pendingAsk?.options ? pendingAsk.options : [];
  const chips =
    options.length > 0
      ? `<div class="ask-options">${options
          .map(
            (option) =>
              `<button type="button" class="ask-chip" data-ask-option="${escapeHtml(option)}">${escapeHtml(option)}</button>`
          )
          .join("")}</div>`
      : "";
  return `
    <article class="timeline-entry entry-message role-assistant is-clarification${isLive ? " is-live" : ""}">
      <div class="message-pill">
        <div class="pill-kicker">Miru needs your input</div>
        <p class="message-copy">${escapeHtml(message.content)}</p>
        ${chips}
      </div>
    </article>
  `;
}

function renderMessageRow(
  message: ChatMessage,
  state: SessionState
): string {
  if (
    message.role === "assistant" &&
    message.relatedStepId &&
    (state.workflowSteps ?? []).some(
      (step) => step.id === message.relatedStepId && step.action.type === "ASK_USER"
    )
  ) {
    return renderClarificationPill(message, state.pendingAsk);
  }

  if (message.role === "user") {
    return `
      <article class="timeline-entry entry-message role-user">
        <div class="message-pill">
          <p class="message-copy">${escapeHtml(message.content)}</p>
        </div>
      </article>
    `;
  }

  if (message.role === "system") {
    return `
      <article class="timeline-entry entry-message role-system">
        <div class="message-pill is-system">
          <p class="message-copy">${escapeHtml(message.content)}</p>
        </div>
      </article>
    `;
  }

  const isStreaming = message.status === "thinking";
  const isError = message.status === "error";
  return `
    <article class="timeline-entry entry-message role-assistant${isError ? " is-error" : ""}${isStreaming ? " is-streaming" : ""}">
      <div class="message-pill">
        <div class="pill-kicker">Miru</div>
        <p class="message-copy${isStreaming ? " is-streaming" : ""}">${escapeHtml(message.content)}</p>
      </div>
    </article>
  `;
}

function renderTimeline(state: SessionState): string {
  const entries = buildTimeline(state);
  if (entries.length === 0) {
    return `
      <article class="timeline-entry entry-message role-assistant">
        <div class="message-pill">
          <div class="pill-kicker">Miru</div>
          <p class="message-copy">What should I do on this page?</p>
        </div>
      </article>
    `;
  }

  return entries
    .map((entry) =>
      entry.kind === "step" ? renderStepRow(entry) : renderMessageRow(entry.data, state)
    )
    .join("");
}

function stateStripContent(state: SessionState): { label: string; tone: string; approve: boolean } | null {
  switch (state.status) {
    case "planning":
      return { label: "Miru is thinking", tone: "thinking", approve: false };
    case "executing":
      return { label: "Running step", tone: "running", approve: false };
    case "awaiting_input":
      return { label: "Miru is asking you a question", tone: "input", approve: false };
    case "awaiting_approval":
      return { label: "Waiting for your approval", tone: "approval", approve: true };
    case "capturing":
      return { label: "Reading the page", tone: "thinking", approve: false };
    default:
      return null;
  }
}

function renderStateStrip(state: SessionState): string {
  const content = stateStripContent(state);
  if (!content) {
    return "";
  }
  const approveBtn = content.approve
    ? `<button type="button" id="approveBtn" class="state-approve">Approve</button>`
    : "";
  return `
    <div class="state-strip tone-${content.tone}" role="status">
      <span class="state-dot" aria-hidden="true"></span>
      <span class="state-label">${escapeHtml(content.label)}</span>
      ${approveBtn}
    </div>
  `;
}

function renderExportToolbar(state: SessionState): string {
  const artifacts = state.scrapeArtifacts ?? [];
  if (artifacts.length === 0) {
    return "";
  }

  const rowCount = artifacts.reduce((total, artifact) => total + artifact.rows.length, 0);

  return `
    <div class="export-toolbar" role="region" aria-label="Export scrape data">
      <span class="export-toolbar-meta">${artifacts.length} table(s) · ${rowCount} row(s)</span>
      <div class="export-toolbar-actions">
        <button type="button" class="export-btn" id="downloadCsvBtn">Download CSV</button>
        <button type="button" class="export-btn export-btn-secondary" id="downloadPdfBtn">Download PDF</button>
      </div>
    </div>
  `;
}

function composerPlaceholder(state: SessionState): string {
  if (state.status === "awaiting_input" && state.pendingAsk) {
    return `Answer Miru — ${state.pendingAsk.question}`;
  }
  if (state.status === "awaiting_approval") {
    return "Refine, or press Approve above";
  }
  return "Message Miru";
}

/**
 * Compress a URL into a short host + path string for the context banner.
 * Falls back to the raw URL when parsing fails (chrome://, about:, malformed).
 */
function describeUrl(url: string | undefined): string {
  if (!url) {
    return "";
  }
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    const path =
      parsed.pathname && parsed.pathname !== "/" ? parsed.pathname.replace(/\/$/, "") : "";
    const trimmedPath = path.length > 32 ? `${path.slice(0, 31)}…` : path;
    return `${host}${trimmedPath}`;
  } catch {
    return url.length > 60 ? `${url.slice(0, 59)}…` : url;
  }
}

/**
 * Build a favicon URL using Chrome's own cached favicon store (chrome-extension
 * `/_favicon/`), which keeps browsing data inside the browser instead of
 * leaking the visited hostname to a third-party (e.g. Google s2). Requires the
 * `favicon` permission and `_favicon/*` listed in web_accessible_resources.
 */
function faviconFor(url: string | undefined): string | null {
  if (!url) {
    return null;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    const base = chrome.runtime.getURL("/_favicon/");
    const params = new URLSearchParams({ pageUrl: url, size: "32" });
    return `${base}?${params.toString()}`;
  } catch {
    return null;
  }
}

function hasActiveSession(state: SessionState): boolean {
  return (
    Boolean(state.id) ||
    state.status !== "idle" ||
    (state.workflowSteps?.length ?? 0) > 0 ||
    (state.chatMessages?.length ?? 0) > 1
  );
}

function renderSessionToolbar(state: SessionState): string {
  if (!hasActiveSession(state)) {
    return "";
  }

  const busy = ["capturing", "planning", "executing"].includes(state.status);

  return `
    <div class="session-toolbar" role="toolbar" aria-label="Session actions">
      <button
        type="button"
        id="resetSessionBtn"
        class="reset-session-btn"
        ${busy ? "disabled" : ""}
        aria-label="Start a new chat"
        title="Clear this session and start a new chat"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 6h18"/>
          <path d="M8 6V4h8v2"/>
          <path d="M19 6l-1 14H6L5 6"/>
          <path d="M10 11v6"/>
          <path d="M14 11v6"/>
        </svg>
        <span>New chat</span>
      </button>
    </div>
  `;
}

function renderContextBanner(state: SessionState): string {
  const context = state.currentContext;
  const isCapturing = state.status === "capturing";

  if (!context && !isCapturing) {
    return `
      <header class="context-banner is-empty" role="status" aria-label="Miru is not viewing a page yet">
        <span class="context-icon" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/></svg>
        </span>
        <div class="context-meta">
          <div class="context-title">No page captured yet</div>
          <div class="context-host">Miru will read this tab when you send a prompt</div>
        </div>
      </header>
    `;
  }

  const title = (context?.title || "Reading the active tab").trim();
  const url = context?.url ?? "";
  const host = describeUrl(url);
  const favicon = faviconFor(url);
  const safeUrl = url ? escapeHtml(url) : "";

  const iconMarkup = favicon
    ? `<img class="context-favicon" src="${escapeHtml(favicon)}" alt="" width="16" height="16" referrerpolicy="no-referrer" loading="lazy" />`
    : `<span class="context-icon" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/></svg></span>`;

  const refreshDisabled = isCapturing ? "disabled" : "";
  const refreshAria = isCapturing ? "Capturing page context" : "Refresh page context";

  return `
    <header class="context-banner${isCapturing ? " is-capturing" : ""}" title="${safeUrl}" role="status" aria-live="polite">
      ${iconMarkup}
      <div class="context-meta">
        <div class="context-title">${escapeHtml(title)}</div>
        <div class="context-host">${host ? escapeHtml(host) : "Reading the active tab"}</div>
      </div>
      <button
        type="button"
        id="contextRefreshBtn"
        class="context-refresh"
        aria-label="${refreshAria}"
        title="${refreshAria}"
        ${refreshDisabled}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 12a9 9 0 0 1 15.5-6.36L21 8"/>
          <path d="M21 3v5h-5"/>
          <path d="M21 12a9 9 0 0 1-15.5 6.36L3 16"/>
          <path d="M3 21v-5h5"/>
        </svg>
      </button>
    </header>
  `;
}

function renderLoadingShell(): string {
  return `
    <div class="viewport">
      <div class="panel panel-loading">
        <header class="context-banner is-empty" role="status" aria-busy="true">
          <span class="context-icon" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/></svg>
          </span>
          <div class="context-meta">
            <div class="context-title">Loading Miru…</div>
            <div class="context-host">Restoring your session</div>
          </div>
        </header>
      </div>
    </div>
  `;
}

function renderApp(state: SessionState, selectedMode: MiruMode): string {
  const busy = ["capturing", "planning", "executing"].includes(state.status);
  const mode = selectedMode;
  const placeholder = composerPlaceholder(state);

  return `
    <div class="viewport">
      <div class="panel">
        ${renderContextBanner(state)}
        <div class="thread-scroll">
          <div class="timeline">
            ${renderTimeline(state)}
          </div>
        </div>
        <div class="composer-stack">
          ${renderSessionToolbar(state)}
          ${renderStateStrip(state)}
          ${renderExportToolbar(state)}
          <div class="mode-float">
            <div class="mode-pill-track" role="group" aria-label="Mode">
              ${renderModePill(mode)}
            </div>
          </div>
          <div class="input-card">
            <label class="sr-only" for="promptInput">Message</label>
            <div class="input-body">
              <textarea id="promptInput" rows="1" placeholder="${escapeHtml(placeholder)}" spellcheck="false"></textarea>
              <button id="sendBtn" class="send-btn" type="button" ${busy ? "disabled" : ""} aria-label="Send">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

async function sendRuntimeMessage(type: string, payload?: unknown): Promise<SessionState> {
  const response = (await chrome.runtime.sendMessage({ type, payload })) as SessionResponseMessage;
  return response.payload;
}

function applyRunSnapshot(state: SessionState, snapshot: RunSessionSnapshot): SessionState {
  return {
    ...state,
    id: snapshot.id,
    runId: snapshot.runId,
    mode: snapshot.mode,
    prompt: snapshot.prompt,
    status: snapshot.status,
    tabId: snapshot.tabId,
    origin: snapshot.origin,
    currentContext: snapshot.currentContext,
    pendingAction: snapshot.pendingAction,
    pendingAsk: snapshot.pendingAsk,
    workflowSteps: snapshot.workflowSteps,
    scrapeArtifacts: snapshot.scrapeArtifacts,
    chatMessages: snapshot.chatMessages,
    lastError: snapshot.lastError,
    updatedAt: snapshot.updatedAt,
  };
}

function applyPlannerStreamEvent(state: SessionState, event: PlannerStreamEvent): SessionState {
  const currentMessages = [...(state.chatMessages ?? [])];
  const getIndex = (messageId: string): number => currentMessages.findIndex((item) => item.id === messageId);

  if (event.type === "assistant_message_start") {
    const idx = getIndex(event.messageId);
    if (idx === -1) {
      currentMessages.push({
        id: event.messageId,
        role: "assistant",
        content: "",
        status: "thinking",
        createdAt: event.createdAt,
      });
    }
    return { ...state, chatMessages: currentMessages.slice(-30) };
  }

  if (event.type === "assistant_token") {
    const idx = getIndex(event.messageId);
    if (idx === -1) {
      currentMessages.push({
        id: event.messageId,
        role: "assistant",
        content: event.token,
        status: "thinking",
        createdAt: event.createdAt,
      });
    } else {
      currentMessages[idx] = {
        ...currentMessages[idx],
        content: `${currentMessages[idx].content}${event.token}`,
        status: "thinking",
      };
    }
    return { ...state, chatMessages: currentMessages.slice(-30) };
  }

  if (event.type === "assistant_message_done") {
    const idx = getIndex(event.messageId);
    if (idx >= 0) {
      currentMessages[idx] = {
        ...currentMessages[idx],
        status: "complete",
      };
    }
    return { ...state, chatMessages: currentMessages.slice(-30) };
  }

  if (event.type === "assistant_message_error") {
    const idx = getIndex(event.messageId);
    const errText = event.error;
    if (idx >= 0) {
      const prior = currentMessages[idx].content.trim();
      currentMessages[idx] = {
        ...currentMessages[idx],
        status: "error",
        content: prior ? `${currentMessages[idx].content}\n${errText}` : errText,
      };
    } else {
      currentMessages.push({
        id: event.messageId,
        role: "assistant",
        content: errText,
        status: "error",
        createdAt: event.createdAt,
      });
    }
    return { ...state, chatMessages: currentMessages.slice(-30), status: "error" };
  }

  return state;
}

function applyStreamEvent(state: SessionState, event: RunStreamEvent): SessionState {
  if (event.type === "run_snapshot") {
    return applyRunSnapshot(state, event.snapshot);
  }
  if (event.type === "run_envelope") {
    return state;
  }
  return applyPlannerStreamEvent(state, event);
}

function normalizeMode(mode: MiruMode): MiruMode {
  return mode === "interactive" ? "ask" : mode;
}

export function initMiruApp(root: HTMLElement): void {
  let booted = false;
  let selectedMode: MiruMode = "ask";
  let state: SessionState = {
    id: null,
    mode: "ask",
    prompt: DEFAULT_PROMPT,
    status: "idle",
    history: [],
    workflowSteps: [],
    scrapeArtifacts: [],
    chatMessages: [],
    isRecording: false,
    updatedAt: Date.now(),
  };

  root.innerHTML = renderLoadingShell();

  const submitAnswer = async (answer: string): Promise<void> => {
    const stepId = state.pendingAsk?.stepId;
    if (!stepId || !answer.trim()) {
      return;
    }
    state = await sendRuntimeMessage(
      MIRU_USE_WS_RUNS && state.runId ? "ANSWER_RUN_ASK" : "RESPOND_TO_ASK",
      { stepId, answer: answer.trim() }
    );
  };

  const submitPrompt = async (text: string): Promise<void> => {
    if (!state.id || state.status === "idle") {
      state = await sendRuntimeMessage("START_SESSION", {
        prompt: text || DEFAULT_PROMPT,
        mode: selectedMode,
      });
      return;
    }
    state = await sendRuntimeMessage("PLAN_NEXT_ACTION", {
      userMessage: text || undefined,
      mode: selectedMode,
    });
  };

  const render = (): void => {
    // Preserve transient DOM state across re-renders so live updates (storage,
    // stream port, background context refresh) don't wipe the user's input or
    // jerk the scroll position when they're reading earlier messages.
    const oldInput = root.querySelector<HTMLTextAreaElement>("#promptInput");
    const inputWasFocused = Boolean(oldInput) && document.activeElement === oldInput;
    const preservedValue = oldInput?.value ?? "";
    const preservedSelStart = oldInput?.selectionStart ?? preservedValue.length;
    const preservedSelEnd = oldInput?.selectionEnd ?? preservedValue.length;
    const oldThread = root.querySelector<HTMLElement>(".thread-scroll");
    const oldScrollTop = oldThread?.scrollTop ?? 0;
    const oldScrollHeight = oldThread?.scrollHeight ?? 0;
    const oldClientHeight = oldThread?.clientHeight ?? 0;
    const wasPinnedToBottom =
      !oldThread || oldScrollHeight - oldClientHeight - oldScrollTop < 32;

    root.innerHTML = renderApp({ ...state, mode: selectedMode }, selectedMode);

    const thread = root.querySelector<HTMLElement>(".thread-scroll");
    if (thread) {
      if (wasPinnedToBottom) {
        thread.scrollTop = thread.scrollHeight;
      } else {
        thread.scrollTop = oldScrollTop;
      }
    }

    const newInput = root.querySelector<HTMLTextAreaElement>("#promptInput");
    if (newInput && preservedValue) {
      newInput.value = preservedValue;
    }
    if (newInput && inputWasFocused) {
      newInput.focus();
      try {
        newInput.setSelectionRange(preservedSelStart, preservedSelEnd);
      } catch {
        // Setting a selection range can throw on certain element states; ignore.
      }
    }

    root.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((button) => {
      button.addEventListener("click", () => {
        selectedMode = normalizeMode(button.dataset.mode as MiruMode);
        render();
      });
    });

    const scrapeArtifacts = state.scrapeArtifacts ?? [];
    if (scrapeArtifacts.length > 0) {
      const baseFilename = exportBaseFilename(state.prompt);
      root.querySelector<HTMLButtonElement>("#downloadCsvBtn")?.addEventListener("click", () => {
        downloadArtifactsCsv(scrapeArtifacts, baseFilename);
      });
      root.querySelector<HTMLButtonElement>("#downloadPdfBtn")?.addEventListener("click", () => {
        downloadArtifactsPdf(scrapeArtifacts, baseFilename);
      });
    }

    root.querySelectorAll<HTMLButtonElement>("[data-ask-option]").forEach((button) => {
      button.addEventListener("click", () => {
        const option = button.dataset.askOption ?? "";
        void (async () => {
          try {
            await submitAnswer(option);
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Request failed.";
            state = { ...state, status: "error", lastError: msg };
          }
          selectedMode = normalizeMode(state.mode);
          render();
        })();
      });
    });

    root.querySelector<HTMLButtonElement>("#approveBtn")?.addEventListener("click", () => {
      void (async () => {
        try {
          state = await sendRuntimeMessage(
            MIRU_USE_WS_RUNS && state.runId ? "APPROVE_RUN_STEP" : "APPROVE_PENDING_ACTION",
            MIRU_USE_WS_RUNS && state.runId && state.pendingAction
              ? { stepId: state.pendingAction.id }
              : undefined
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Request failed.";
          state = { ...state, status: "error", lastError: msg };
        }
        selectedMode = normalizeMode(state.mode);
        render();
      })();
    });

    root.querySelector<HTMLButtonElement>("#resetSessionBtn")?.addEventListener("click", () => {
      void (async () => {
        try {
          state = await sendRuntimeMessage("STOP_SESSION");
          selectedMode = normalizeMode(state.mode);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Reset failed.";
          state = { ...state, status: "error", lastError: msg };
        }
        render();
      })();
    });

    root.querySelector<HTMLButtonElement>("#contextRefreshBtn")?.addEventListener("click", () => {
      void (async () => {
        // Optimistic flip to capturing tone so the banner reacts instantly,
        // before the SW round-trip completes.
        state = { ...state, status: "capturing" };
        render();
        try {
          state = await sendRuntimeMessage("REFRESH_CONTEXT");
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Refresh failed.";
          state = { ...state, status: "error", lastError: msg };
        }
        selectedMode = normalizeMode(state.mode);
        render();
      })();
    });

    const send = async (): Promise<void> => {
      const promptInput = root.querySelector<HTMLTextAreaElement>("#promptInput");
      const text = (promptInput?.value ?? "").trim();
      if (promptInput) {
        promptInput.value = "";
      }

      try {
        if (state.status === "awaiting_input" && state.pendingAsk && text) {
          await submitAnswer(text);
        } else {
          await submitPrompt(text);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Request failed.";
        const id = crypto.randomUUID();
        const fallbackMessage: ChatMessage = {
          id,
          role: "assistant",
          content: msg,
          status: "error",
          createdAt: Date.now(),
        };
        state = {
          ...state,
          status: "error",
          lastError: msg,
          chatMessages: [...(state.chatMessages ?? []), fallbackMessage].slice(-30),
        };
      }

      selectedMode = normalizeMode(state.mode);
      render();
    };

    root.querySelector<HTMLButtonElement>("#sendBtn")?.addEventListener("click", () => {
      void send();
    });

    root.querySelector<HTMLTextAreaElement>("#promptInput")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (["capturing", "planning", "executing"].includes(state.status)) {
          return;
        }
        void send();
      }
    });
  };

  /**
   * Replace in-memory state with the persisted session snapshot. Used on panel
   * open / visibility resume so we never flash the empty default UI over a
   * real session.
   */
  const hydrateFromSession = (incoming: SessionState): void => {
    state = incoming;
    selectedMode = normalizeMode(incoming.mode);
  };

  /**
   * Patch banner/status fields from storage while a session is already running
   * in this panel. Skipped until boot completes so we don't render an empty
   * timeline over a real session during the GET_SESSION race.
   */
  const applyLiveSessionUpdate = (incoming: SessionState): boolean => {
    if (!booted) {
      return false;
    }

    if (incoming.id && !state.id) {
      hydrateFromSession(incoming);
      return true;
    }

    const workflowChanged =
      JSON.stringify(incoming.workflowSteps ?? []) !== JSON.stringify(state.workflowSteps ?? []);
    const artifactsChanged =
      JSON.stringify(incoming.scrapeArtifacts ?? []) !== JSON.stringify(state.scrapeArtifacts ?? []);
    const chatChanged =
      JSON.stringify(incoming.chatMessages ?? []) !== JSON.stringify(state.chatMessages ?? []);
    const contextChanged =
      incoming.currentContext?.url !== state.currentContext?.url ||
      incoming.currentContext?.title !== state.currentContext?.title ||
      incoming.currentContext?.timestamp !== state.currentContext?.timestamp;
    const statusChanged = incoming.status !== state.status;
    const tabChanged = incoming.tabId !== state.tabId || incoming.origin !== state.origin;
    const runChanged = incoming.runId !== state.runId;
    const gateChanged =
      incoming.pendingAsk !== state.pendingAsk ||
      incoming.pendingAction !== state.pendingAction ||
      incoming.lastError !== state.lastError;

    if (
      !workflowChanged &&
      !artifactsChanged &&
      !chatChanged &&
      !contextChanged &&
      !statusChanged &&
      !tabChanged &&
      !runChanged &&
      !gateChanged
    ) {
      return false;
    }

    state = {
      ...state,
      runId: incoming.runId,
      currentContext: incoming.currentContext,
      status: incoming.status,
      tabId: incoming.tabId,
      origin: incoming.origin,
      pendingAsk: incoming.pendingAsk,
      pendingAction: incoming.pendingAction,
      lastError: incoming.lastError,
      workflowSteps: incoming.workflowSteps ?? state.workflowSteps,
      scrapeArtifacts: incoming.scrapeArtifacts ?? state.scrapeArtifacts,
      chatMessages: incoming.chatMessages ?? state.chatMessages,
    };
    return true;
  };

  const resyncPanel = async (): Promise<void> => {
    try {
      hydrateFromSession(await sendRuntimeMessage("SYNC_PANEL_OPEN"));
      render();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to restore session.";
      state = { ...state, status: "error", lastError: msg };
      render();
    }
  };

  const boot = async (): Promise<void> => {
    const streamPort = chrome.runtime.connect({ name: "miru-session-stream" });
    streamPort.onMessage.addListener((message: SessionStreamEventMessage) => {
      if (!message || message.type !== "SESSION_STREAM_EVENT" || !message.payload) {
        return;
      }

      state = applyStreamEvent(state, message.payload);
      render();
    });

    try {
      hydrateFromSession(await sendRuntimeMessage("SYNC_PANEL_OPEN"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to start Miru.";
      state = {
        ...state,
        status: "error",
        lastError: msg,
        chatMessages: [
          ...(state.chatMessages ?? []),
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: msg,
            status: "error",
            createdAt: Date.now(),
          },
        ],
      };
    }

    booted = true;
    render();

    // Live banner / status updates after hydration — never before booted.
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "session" || !booted) {
        return;
      }
      const update = changes[SESSION_STORAGE_KEY];
      if (!update || !update.newValue) {
        return;
      }
      const incoming = update.newValue as SessionState;
      if (applyLiveSessionUpdate(incoming)) {
        render();
      }
    });

    // Panel hidden then shown again without a full document reload (Chrome can
    // keep the side panel document alive). Re-hydrate so we don't show stale UI.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible" || !booted) {
        return;
      }
      if (MIRU_USE_WS_RUNS) {
        void sendRuntimeMessage("SYNC_RUN").then((incoming) => {
          hydrateFromSession(incoming);
          render();
        }).catch(() => undefined);
      } else {
        void resyncPanel();
      }
    });
  };

  void boot();
}
