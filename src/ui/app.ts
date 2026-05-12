import { DEFAULT_PROMPT } from "../shared/constants.js";
import type {
  ChatMessage,
  MiruAction,
  MiruMode,
  PlannerStreamEvent,
  SessionResponseMessage,
  SessionState,
  SessionStreamEventMessage,
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

function formatAction(action?: MiruAction): string {
  if (!action) {
    return "Waiting for the next command";
  }

  switch (action.type) {
    case "QUERY":
      return `Inspect ${action.selector}`;
    case "CLICK":
      return `Click ${action.selector}`;
    case "TYPE":
      return `Type into ${action.selector}`;
    case "SCROLL":
      return `Scroll ${action.direction}`;
    case "WAIT":
      return `Wait ${action.durationMs}ms`;
    case "EXTRACT":
      return `Extract ${action.fields.map((field) => field.name).join(", ")}`;
    case "EXTRACT_LIST":
      return `Extract list ${action.itemSelector} (${action.fields.map((field) => field.name).join(", ")})`;
    case "STOP":
      return `Stop: ${action.reason}`;
    default:
      return "Unknown command";
  }
}

function summarizeResult(value: unknown): string {
  if (value === undefined || value === null) {
    return "No result yet.";
  }

  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
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

function defaultMessages(state: SessionState): ChatMessage[] {
  const fallback: ChatMessage[] = [];

  if (state.lastResult) {
    fallback.push({
      id: `result-${state.updatedAt}`,
      role: "assistant",
      content: `Result: ${summarizeResult(state.lastResult.result ?? state.lastResult.error)}`,
      status: state.lastResult.success ? "complete" : "error",
      createdAt: state.updatedAt,
    });
  }

  if (fallback.length === 0) {
    fallback.push({
      id: "assistant-welcome",
      role: "assistant",
      content: "What should I do on this page?",
      status: "complete",
      createdAt: Date.now(),
    });
  }

  return fallback;
}

function renderMessages(state: SessionState): string {
  const messages = (state.chatMessages && state.chatMessages.length > 0 ? state.chatMessages : defaultMessages(state)).slice(
    -40
  );

  return messages
    .map((message) => {
      const roleClass = `message-${message.role}`;
      const statusText =
        message.status === "thinking"
          ? "Thinking"
          : message.status === "running"
            ? "Running"
            : message.status === "error"
              ? "Error"
              : "";

      const errorClass = message.status === "error" ? " is-error" : "";

      return `
        <article class="message-row ${roleClass}${errorClass}">
          <div class="message-bubble">
            <p class="message-copy ${message.status === "thinking" ? "is-streaming" : ""}">${escapeHtml(message.content)}</p>
            ${statusText ? `<div class="message-status">${escapeHtml(statusText)}</div>` : ""}
          </div>
        </article>
      `;
    })
    .join("");
}

function textareaValue(_state: SessionState): string {
  // Composer stays empty; chat history holds user messages (state.prompt is kept for the planner).
  return "";
}

function renderStructuredNextStep(state: SessionState): string {
  const pending = state.pendingAction;
  if (!pending) {
    return "";
  }

  const needsApproval = pending.requiresConfirmation || state.status === "awaiting_approval";
  const approvalNote = needsApproval
    ? `<p class="next-step-note">This step needs your approval before it runs.</p>`
    : "";

  return `
    <aside class="next-step-card" aria-label="Structured next command">
      <div class="next-step-kicker">Next step (what will run)</div>
      <p class="next-step-command">${escapeHtml(formatAction(pending.action))}</p>
      <p class="next-step-rationale">${escapeHtml(pending.rationale)}</p>
      ${approvalNote}
    </aside>
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

function renderApp(state: SessionState, selectedMode: MiruMode): string {
  const busy = ["capturing", "planning", "executing"].includes(state.status);
  const mode = selectedMode;

  return `
    <div class="viewport">
      <div class="panel">
        ${renderStructuredNextStep(state)}
        <div class="thread-scroll">
          ${renderMessages(state)}
        </div>
        <div class="composer-stack">
          ${renderExportToolbar(state)}
          <div class="mode-float">
            <div class="mode-pill-track" role="group" aria-label="Mode">
              ${renderModePill(mode)}
            </div>
          </div>
          <div class="input-card">
            <label class="sr-only" for="promptInput">Message</label>
            <div class="input-body">
              <textarea id="promptInput" rows="1" placeholder="Message Miru" spellcheck="false">${escapeHtml(textareaValue(state))}</textarea>
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

function applyStreamEvent(state: SessionState, event: PlannerStreamEvent): SessionState {
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

function normalizeMode(mode: MiruMode): MiruMode {
  return mode === "interactive" ? "ask" : mode;
}

export function initMiruApp(root: HTMLElement): void {
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

  const render = (): void => {
    root.innerHTML = renderApp({ ...state, mode: selectedMode }, selectedMode);
    const thread = root.querySelector<HTMLElement>(".thread-scroll");
    if (thread) {
      thread.scrollTop = thread.scrollHeight;
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

    const send = async (): Promise<void> => {
      const promptInput = root.querySelector<HTMLTextAreaElement>("#promptInput");
      const text = (promptInput?.value ?? "").trim();
      if (promptInput) {
        promptInput.value = "";
      }

      try {
        if (state.status === "awaiting_approval" && state.pendingAction) {
          state = await sendRuntimeMessage("APPROVE_PENDING_ACTION");
        } else if (!state.id || state.status === "idle") {
          state = await sendRuntimeMessage("START_SESSION", {
            prompt: text || DEFAULT_PROMPT,
            mode: selectedMode,
          });
        } else {
          state = await sendRuntimeMessage("PLAN_NEXT_ACTION", {
            userMessage: text || undefined,
            mode: selectedMode,
          });
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

  const boot = async (): Promise<void> => {
    const streamPort = chrome.runtime.connect({ name: "miru-session-stream" });
    streamPort.onMessage.addListener((message: SessionStreamEventMessage) => {
      if (!message || message.type !== "SESSION_STREAM_EVENT" || !message.payload) {
        return;
      }

      state = applyStreamEvent(state, message.payload);
      render();
    });

    state = await sendRuntimeMessage("GET_SESSION");
    selectedMode = normalizeMode(state.mode);
    render();
  };

  void boot();
}
