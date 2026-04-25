import { DEFAULT_PROMPT } from "../shared/constants.js";
import type {
  ChatMessage,
  ExportScriptResponseMessage,
  MiruAction,
  MiruMode,
  PlannerStreamEvent,
  SessionResponseMessage,
  SessionState,
  SessionStreamEventMessage,
  WorkflowStep,
} from "../shared/types.js";

const modeMeta: Record<MiruMode, { label: string; detail: string }> = {
  auto: {
    label: "Auto",
    detail: "Runs safe steps continuously.",
  },
  ask: {
    label: "Ask",
    detail: "Asks before page-changing steps.",
  },
  interactive: {
    label: "Interactive",
    detail: "Stops on every step.",
  },
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatTime(timestamp?: number): string {
  if (!timestamp) {
    return "";
  }

  return new Date(timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
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

function renderModeChips(selectedMode: MiruMode): string {
  return (Object.keys(modeMeta) as MiruMode[])
    .map((mode) => {
      const meta = modeMeta[mode];
      return `
        <button class="mode-chip ${selectedMode === mode ? "is-active" : ""}" type="button" data-mode="${mode}" title="${escapeHtml(meta.detail)}">
          <span class="mode-chip-label">${meta.label}</span>
        </button>
      `;
    })
    .join("");
}

function renderWorkflowSteps(steps: WorkflowStep[] | undefined): string {
  const items = (steps ?? []).slice(-4);
  if (items.length === 0) {
    return `<div class="workflow-empty">Commands will appear here as Miru builds the session.</div>`;
  }

  return items
    .map(
      (step) => `
        <article class="workflow-step">
          <div class="workflow-step-main">
            <p class="workflow-step-title">${escapeHtml(step.title || formatAction(step.action))}</p>
            <p class="workflow-step-copy">${escapeHtml(step.resultSummary || step.rationale || "Waiting for result")}</p>
          </div>
          <div class="workflow-step-meta">
            <span class="workflow-step-status">${escapeHtml(step.status)}</span>
            <time>${formatTime(step.updatedAt)}</time>
          </div>
        </article>
      `
    )
    .join("");
}

function defaultMessages(state: SessionState): ChatMessage[] {
  const fallback: ChatMessage[] = [];

  if (state.pendingAction) {
    fallback.push({
      id: state.pendingAction.id,
      role: "assistant",
      content: `Next command: ${formatAction(state.pendingAction.action)}. ${state.pendingAction.rationale}`,
      status: "complete",
      createdAt: state.updatedAt,
      relatedStepId: state.pendingAction.id,
    });
  }

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
      content:
        "Describe the crawl you want. Miru will think in chat, act on the page, and can record the session as JavaScript.",
      status: "complete",
      createdAt: Date.now(),
    });
  }

  return fallback;
}

function renderMessages(state: SessionState): string {
  const messages = (state.chatMessages && state.chatMessages.length > 0 ? state.chatMessages : defaultMessages(state)).slice(-14);

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

      return `
        <article class="message-row ${roleClass}">
          <div class="message-bubble">
            <div class="message-head">
              <span class="message-role">${escapeHtml(message.role === "assistant" ? "Miru" : message.role === "user" ? "You" : "System")}</span>
              <span class="message-time">${formatTime(message.createdAt)}</span>
            </div>
            <p class="message-copy ${message.status === "thinking" ? "is-streaming" : ""}">${escapeHtml(message.content)}</p>
            ${statusText ? `<div class="message-status">${statusText}</div>` : ""}
          </div>
        </article>
      `;
    })
    .join("");
}

function renderApp(state: SessionState, hasStreamedResponse: boolean): string {
  const mode = state.mode || "interactive";
  const pendingAction = state.pendingAction;
  const workflowCount = (state.workflowSteps ?? []).length;
  const routineSummary = state.recordedSession
    ? `${state.recordedSession.workflowSteps.length} recorded step${state.recordedSession.workflowSteps.length === 1 ? "" : "s"}`
    : "Not recording";
  const shellClass = hasStreamedResponse ? "has-streamed-response" : "is-input-centered";

  return `
    <div class="chat-shell ${shellClass}">
      <header class="chat-header glass-shell">
        <div>
          <p class="brand-mark">Miru</p>
          <h1>Chat-first crawler studio</h1>
        </div>
        <div class="header-meta">
          <span class="status-pill status-${state.status}">${state.status}</span>
        </div>
      </header>

      <section class="chat-main">
        <div class="chat-thread glass-shell">
          <div class="thread-scroll">
            ${renderMessages(state)}
          </div>
        </div>
      </section>

      <footer class="composer glass-shell">
        <div class="composer-top surface-card">
          <div class="mode-row">
            <span class="sidebar-label inline-label">Mode</span>
            ${renderModeChips(mode)}
          </div>
          <div class="composer-actions compact-actions">
            <button id="recordBtnInline" class="ghost-button compact" type="button">${state.isRecording ? "Stop rec" : "Record"}</button>
            <button id="refreshBtn" class="ghost-button compact" type="button">Refresh memory</button>
          </div>
        </div>
        <label class="composer-field">
          <textarea id="promptInput" rows="3" placeholder="Tell Miru what to crawl, extract, or test next...">${escapeHtml(
            state.prompt || DEFAULT_PROMPT
          )}</textarea>
        </label>
        <div class="composer-bottom surface-card">
          <div class="live-session-meta">
            <p class="composer-hint">${escapeHtml(
              pendingAction?.rationale ||
                "Conversation becomes workflow, workflow becomes reusable JavaScript."
            )}</p>
            <div class="sidebar-meta">
              <span>${pendingAction ? `${Math.round(pendingAction.confidence * 100)}% confidence` : "Waiting for first plan"}</span>
              <span>${pendingAction?.requiresConfirmation ? "Needs approval" : "Can continue"}</span>
              <span>${workflowCount} step${workflowCount === 1 ? "" : "s"}</span>
              <span>${escapeHtml(routineSummary)}</span>
            </div>
          </div>
          <div class="composer-actions">
            <button id="planBtn" class="secondary-button" type="button">Refine</button>
            <button id="approveBtn" class="secondary-button" type="button" ${pendingAction ? "" : "disabled"}>Approve</button>
            <button id="exportBtn" class="secondary-button" type="button" ${(state.workflowSteps ?? []).length > 0 ? "" : "disabled"}>Export JS</button>
            <button id="resetBtn" class="ghost-button" type="button">Reset</button>
            <button id="startBtn" class="primary-button" type="button">Send</button>
          </div>
        </div>
        <details class="workflow-drawer">
          <summary>Recent workflow steps</summary>
          <div class="workflow-list">
            ${renderWorkflowSteps(state.workflowSteps)}
          </div>
        </details>
        <div class="composer-top mobile-header-meta">
          <div class="mode-row">
            <span class="sidebar-label inline-label">Status</span>
            <span class="status-pill status-${state.status}">${state.status}</span>
          </div>
          <div class="composer-actions compact-actions">
            <button id="recordBtnMobile" class="ghost-button compact" type="button">${state.isRecording ? "Stop rec" : "Record"}</button>
          </div>
        </div>
      </footer>
    </div>
  `;
}

async function sendRuntimeMessage(type: string, payload?: unknown): Promise<SessionState> {
  const response = (await chrome.runtime.sendMessage({ type, payload })) as SessionResponseMessage;
  return response.payload;
}

async function exportRecordedScript(): Promise<{ filename: string; script: string }> {
  const response = (await chrome.runtime.sendMessage({ type: "EXPORT_SESSION_SCRIPT" })) as ExportScriptResponseMessage;
  return response.payload;
}

function downloadTextFile(filename: string, script: string): void {
  const blob = new Blob([script], { type: "text/javascript;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
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

  const idx = getIndex(event.messageId);
  if (idx >= 0) {
    currentMessages[idx] = {
      ...currentMessages[idx],
      status: "error",
      content: `${currentMessages[idx].content}\n${event.error}`,
    };
  } else {
    currentMessages.push({
      id: event.messageId,
      role: "assistant",
      content: event.error,
      status: "error",
      createdAt: event.createdAt,
    });
  }

  return { ...state, chatMessages: currentMessages.slice(-30) };
}

export function initMiruApp(root: HTMLElement): void {
  let selectedMode: MiruMode = "interactive";
  let hasStreamedResponse = false;
  let state: SessionState = {
    id: null,
    mode: "interactive",
    prompt: DEFAULT_PROMPT,
    status: "idle",
    history: [],
    workflowSteps: [],
    chatMessages: [],
    isRecording: false,
    updatedAt: Date.now(),
  };

  const render = (): void => {
    root.innerHTML = renderApp({ ...state, mode: selectedMode || state.mode }, hasStreamedResponse);
    const thread = root.querySelector<HTMLElement>(".thread-scroll");
    if (thread) {
      thread.scrollTop = thread.scrollHeight;
    }

    root.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((button) => {
      button.addEventListener("click", () => {
        selectedMode = button.dataset.mode as MiruMode;
        render();
      });
    });

    root.querySelector<HTMLButtonElement>("#startBtn")?.addEventListener("click", async () => {
      const promptInput = root.querySelector<HTMLTextAreaElement>("#promptInput");
      state = await sendRuntimeMessage("START_SESSION", {
        prompt: promptInput?.value || DEFAULT_PROMPT,
        mode: selectedMode,
      });
      selectedMode = state.mode;
      render();
    });

    root.querySelector<HTMLButtonElement>("#planBtn")?.addEventListener("click", async () => {
      state = await sendRuntimeMessage("PLAN_NEXT_ACTION");
      selectedMode = state.mode;
      render();
    });

    root.querySelector<HTMLButtonElement>("#approveBtn")?.addEventListener("click", async () => {
      state = await sendRuntimeMessage("APPROVE_PENDING_ACTION");
      selectedMode = state.mode;
      render();
    });

    root.querySelector<HTMLButtonElement>("#refreshBtn")?.addEventListener("click", async () => {
      state = await sendRuntimeMessage("REFRESH_CONTEXT");
      selectedMode = state.mode;
      render();
    });

    root.querySelector<HTMLButtonElement>("#recordBtnInline")?.addEventListener("click", async () => {
      state = await sendRuntimeMessage("TOGGLE_RECORDING");
      selectedMode = state.mode;
      render();
    });
    root.querySelector<HTMLButtonElement>("#recordBtnMobile")?.addEventListener("click", async () => {
      state = await sendRuntimeMessage("TOGGLE_RECORDING");
      selectedMode = state.mode;
      render();
    });

    root.querySelector<HTMLButtonElement>("#exportBtn")?.addEventListener("click", async () => {
      const exported = await exportRecordedScript();
      downloadTextFile(exported.filename, exported.script);
      state = await sendRuntimeMessage("GET_SESSION");
      render();
    });

    root.querySelector<HTMLButtonElement>("#resetBtn")?.addEventListener("click", async () => {
      state = await sendRuntimeMessage("STOP_SESSION");
      selectedMode = state.mode;
      render();
    });
  };

  const boot = async (): Promise<void> => {
    const streamPort = chrome.runtime.connect({ name: "miru-session-stream" });
    streamPort.onMessage.addListener((message: SessionStreamEventMessage) => {
      if (!message || message.type !== "SESSION_STREAM_EVENT" || !message.payload) {
        return;
      }

      state = applyStreamEvent(state, message.payload);
      if (message.payload.type === "assistant_token") {
        hasStreamedResponse = true;
      }
      render();
    });

    state = await sendRuntimeMessage("GET_SESSION");
    selectedMode = state.mode;
    hasStreamedResponse = (state.chatMessages ?? []).some(
      (message) => message.role === "assistant" && message.content.trim().length > 0
    );
    render();
  };

  void boot();
}
