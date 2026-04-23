import { DEFAULT_PROMPT } from "../shared/constants.js";
import type {
  MiruAction,
  MiruMode,
  SessionResponseMessage,
  SessionState,
} from "../shared/types.js";

const modeMeta: Record<
  MiruMode,
  { label: string; detail: string }
> = {
  auto: {
    label: "Auto run",
    detail: "Runs low and medium risk steps automatically. High-risk steps still pause.",
  },
  ask: {
    label: "Ask mode",
    detail: "Runs safe read-only steps automatically and asks before actions that change the page.",
  },
  interactive: {
    label: "Interactive",
    detail: "Pauses on every proposed step so you can review the plan one action at a time.",
  },
};

function formatAction(action?: MiruAction): string {
  if (!action) {
    return "No action planned yet.";
  }

  switch (action.type) {
    case "QUERY":
      return `Query ${action.selector}`;
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
      return "Unknown action";
  }
}

function formatTime(timestamp?: number): string {
  if (!timestamp) {
    return "Not captured yet";
  }

  return new Date(timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderModeChips(selectedMode: MiruMode): string {
  return (Object.keys(modeMeta) as MiruMode[])
    .map((mode) => {
      const meta = modeMeta[mode];
      return `
        <button class="mode-chip ${selectedMode === mode ? "is-active" : ""}" type="button" data-mode="${mode}">
          <span class="mode-chip-label">${meta.label}</span>
          <span class="mode-chip-detail">${meta.detail}</span>
        </button>
      `;
    })
    .join("");
}

function renderApp(state: SessionState): string {
  const mode = state.mode || "interactive";
  const context = state.currentContext;
  const pendingAction = state.pendingAction;
  const metricsMarkup = context
    ? `
          <div class="metric-grid">
            <div class="metric-card">
              <span>Visible text</span>
              <strong>${context.visibleTextLength}</strong>
            </div>
            <div class="metric-card">
              <span>Links</span>
              <strong>${context.linkCount}</strong>
            </div>
            <div class="metric-card">
              <span>Forms</span>
              <strong>${context.formCount}</strong>
            </div>
            <div class="metric-card">
              <span>Targets</span>
              <strong>${context.interactiveElements.length}</strong>
            </div>
          </div>
      `
    : `
          <div class="empty-state-card">
            <p class="empty-state-title">No page context yet</p>
            <p class="empty-state-copy">
              Start a session when you're on a page you want Miru to inspect. The live metrics, screenshot,
              and HTML preview will appear here once capture runs.
            </p>
          </div>
      `;
  const events = state.history
    .slice()
    .reverse()
    .map(
      (event) => `
        <article class="timeline-item timeline-${event.status}">
          <div class="timeline-copy">
            <p class="timeline-title">${escapeHtml(event.title)}</p>
            <p class="timeline-detail">${escapeHtml(event.detail)}</p>
          </div>
          <time class="timeline-time">${formatTime(event.createdAt)}</time>
        </article>
      `
    )
    .join("");

  return `
    <div class="shell shell-sidepanel">
      <div class="ambient ambient-one"></div>
      <div class="ambient ambient-two"></div>

      <section class="hero glass-panel">
        <div class="hero-topline">
          <span class="badge">Miru V1</span>
          <span class="badge muted">Side panel session</span>
        </div>
        <div class="hero-copy">
          <h1>Visual browser automation for developers.</h1>
          <p>
            Miru builds context from the live page, the visible screenshot, and the HTML summary before it
            chooses the next step.
          </p>
        </div>
      </section>

      <section class="glass-panel compose-panel">
        <div class="panel-header">
          <div>
            <p class="eyebrow">Session prompt</p>
            <h2>Start or continue a Miru run</h2>
          </div>
          <span class="status-pill status-${state.status}">${state.status}</span>
        </div>

        <label class="field">
          <span>Task prompt</span>
          <textarea id="promptInput" rows="5" placeholder="Tell Miru what to inspect or do.">${escapeHtml(
            state.prompt || DEFAULT_PROMPT
          )}</textarea>
        </label>

        <div class="mode-grid">
          ${renderModeChips(mode)}
        </div>

        <div class="action-row">
          <button id="startBtn" class="primary-button" type="button">Start session</button>
          <button id="planBtn" class="secondary-button" type="button">Plan next step</button>
          <button id="approveBtn" class="secondary-button" type="button" ${
            pendingAction ? "" : "disabled"
          }>Approve and run</button>
          <button id="stopBtn" class="ghost-button" type="button">End session</button>
        </div>
      </section>

      <section class="grid">
        <article class="glass-panel metrics-panel">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Current page</p>
              <h2>${escapeHtml(context?.title || "Waiting for first capture")}</h2>
            </div>
            <span class="tiny-copy">${context ? `Captured ${formatTime(context.timestamp)}` : "Session memory is empty"}</span>
          </div>

          ${metricsMarkup}

          <div class="context-url">${escapeHtml(context?.url || "Open a target page, then start or refresh a session to load context.")}</div>

          <div class="context-html">
            <p class="eyebrow">HTML preview</p>
            <pre>${escapeHtml(context?.htmlPreview || "Miru stores the latest screenshot and DOM summary only for the active session.")}</pre>
          </div>
        </article>

        <article class="glass-panel screenshot-panel">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Visible screenshot</p>
              <h2>Session-only visual memory</h2>
            </div>
            <span class="tiny-copy">Deleted when the session ends</span>
          </div>

          ${
            context?.screenshotDataUrl
              ? `<img class="screenshot-preview" src="${context.screenshotDataUrl}" alt="Current page screenshot">`
              : `<div class="screenshot-empty">Miru captures the visible tab only after you start or refresh a session.</div>`
          }
        </article>
      </section>

      <section class="grid grid-bottom">
        <article class="glass-panel action-panel">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Next step</p>
              <h2>${escapeHtml(formatAction(pendingAction?.action))}</h2>
            </div>
            <span class="risk-pill risk-${pendingAction?.risk || "low"}">${pendingAction?.risk || "low"} risk</span>
          </div>

          <p class="action-rationale">${escapeHtml(
            pendingAction?.rationale || "Miru will propose the next action after it captures the current tab context."
          )}</p>

          <div class="meta-row">
            <span>Confidence ${pendingAction ? Math.round(pendingAction.confidence * 100) : 0}%</span>
            <span>${pendingAction?.requiresConfirmation ? "Requires confirmation" : "Can run automatically"}</span>
          </div>

          <div class="result-card ${state.lastResult?.success ? "is-success" : state.lastError ? "is-error" : ""}">
            <p class="eyebrow">Latest result</p>
            <pre>${escapeHtml(
              JSON.stringify(state.lastResult?.result ?? state.lastError ?? "No action has been run yet.", null, 2)
            )}</pre>
          </div>
        </article>

        <article class="glass-panel timeline-panel">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Timeline</p>
              <h2>Session events</h2>
            </div>
            <span class="tiny-copy">${state.history.length} entries</span>
          </div>

          <div class="timeline-list">
            ${
              events ||
              '<div class="timeline-empty">Miru will log context capture, plan decisions, approvals, and execution results here.</div>'
            }
          </div>
        </article>
      </section>
    </div>
  `;
}

async function sendRuntimeMessage(type: string, payload?: unknown): Promise<SessionState> {
  const response = (await chrome.runtime.sendMessage({ type, payload })) as SessionResponseMessage;
  return response.payload;
}

export function initMiruApp(root: HTMLElement): void {
  let selectedMode: MiruMode = "interactive";
  let state: SessionState = {
    id: null,
    mode: "interactive",
    prompt: DEFAULT_PROMPT,
    status: "idle",
    history: [],
    updatedAt: Date.now(),
  };

  const render = (): void => {
    root.innerHTML = renderApp({ ...state, mode: selectedMode || state.mode });

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

    root.querySelector<HTMLButtonElement>("#refreshBtn")?.addEventListener("click", async () => {
      state = await sendRuntimeMessage("REFRESH_CONTEXT");
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

    root.querySelector<HTMLButtonElement>("#stopBtn")?.addEventListener("click", async () => {
      state = await sendRuntimeMessage("STOP_SESSION");
      selectedMode = state.mode;
      render();
    });
  };

  const boot = async (): Promise<void> => {
    state = await sendRuntimeMessage("GET_SESSION");
    selectedMode = state.mode;
    render();
  };

  void boot();
}
