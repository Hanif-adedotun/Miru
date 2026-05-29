/**
 * In-page overlay for Miru auto mode: banner, target bounding box, and cursor hint.
 */

import {
  actionOverlayLabel,
  actionTargetSelector,
  AUTO_OVERLAY_BANNER,
  type PageAutomationOverlayPayload,
  type PageOverlayPhase,
} from "../shared/overlay.js";

const OVERLAY_HOST_ID = "miru-overlay-host";

const PHASE_LABELS: Record<PageOverlayPhase, string> = {
  planning: "Planning next step…",
  preview: "Next action",
  executing: "Running action",
  waiting: "Waiting for approval",
  idle: "",
};

interface CursorPoint {
  x: number;
  y: number;
}

let overlayHost: HTMLElement | null = null;
let shadowRoot: ShadowRoot | null = null;
let bannerEl: HTMLElement | null = null;
let targetBoxEl: HTMLElement | null = null;
let targetLabelEl: HTMLElement | null = null;
let cursorEl: HTMLElement | null = null;
let lastCursor: CursorPoint = { x: 24, y: 24 };
let repositionScheduled = false;
let listenersBound = false;
let activeSelector: string | null = null;

function ensureOverlayHost(): ShadowRoot {
  if (overlayHost?.isConnected && shadowRoot) {
    return shadowRoot;
  }

  overlayHost = document.createElement("div");
  overlayHost.id = OVERLAY_HOST_ID;
  overlayHost.setAttribute("aria-hidden", "true");
  overlayHost.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483646; pointer-events: none;";
  shadowRoot = overlayHost.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = `
    :host {
      all: initial;
    }
    .miru-veil {
      position: fixed;
      inset: 0;
      background: rgba(2, 6, 23, 0.08);
      pointer-events: none;
    }
    .miru-banner {
      position: fixed;
      top: 16px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      align-items: center;
      gap: 10px;
      max-width: min(92vw, 560px);
      padding: 10px 16px;
      border-radius: 999px;
      background: rgba(15, 23, 42, 0.94);
      color: #f8fafc;
      font: 600 13px/1.35 system-ui, -apple-system, Segoe UI, sans-serif;
      letter-spacing: 0.01em;
      box-shadow: 0 12px 40px rgba(15, 23, 42, 0.35);
      border: 1px solid rgba(56, 189, 248, 0.45);
      pointer-events: none;
      z-index: 2;
    }
    .miru-banner-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #38bdf8;
      box-shadow: 0 0 0 4px rgba(56, 189, 248, 0.25);
      animation: miru-pulse 1.4s ease-in-out infinite;
      flex-shrink: 0;
    }
    .miru-banner-copy {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    .miru-banner-title {
      font-weight: 700;
      font-size: 13px;
    }
    .miru-banner-sub {
      font-weight: 500;
      font-size: 11px;
      color: #94a3b8;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .miru-target-box {
      position: fixed;
      border: 2px solid rgba(56, 189, 248, 0.95);
      border-radius: 10px;
      box-shadow:
        0 0 0 4px rgba(56, 189, 248, 0.18),
        0 0 24px rgba(56, 189, 248, 0.35);
      background: rgba(56, 189, 248, 0.06);
      pointer-events: none;
      z-index: 1;
      transition: top 160ms ease, left 160ms ease, width 160ms ease, height 160ms ease;
    }
    .miru-target-label {
      position: fixed;
      max-width: min(80vw, 420px);
      padding: 6px 10px;
      border-radius: 8px;
      background: rgba(15, 23, 42, 0.92);
      color: #e2e8f0;
      font: 500 11px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace;
      border: 1px solid rgba(56, 189, 248, 0.35);
      pointer-events: none;
      z-index: 2;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .miru-cursor {
      position: fixed;
      width: 22px;
      height: 22px;
      margin-left: -2px;
      margin-top: -2px;
      border-radius: 50%;
      border: 2px solid #0f172a;
      background: #38bdf8;
      box-shadow: 0 4px 14px rgba(15, 23, 42, 0.35);
      pointer-events: none;
      z-index: 3;
      transition: transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
    }
    .miru-cursor::after {
      content: "";
      position: absolute;
      left: 50%;
      top: 50%;
      width: 6px;
      height: 6px;
      margin: -3px 0 0 -3px;
      border-radius: 50%;
      background: #f8fafc;
    }
    @keyframes miru-pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.55; transform: scale(0.85); }
    }
    .miru-cursor.is-clicking {
      transform: scale(0.88);
      transition: transform 120ms ease;
    }
    @media (prefers-reduced-motion: reduce) {
      .miru-target-box,
      .miru-cursor {
        transition: none;
      }
      .miru-banner-dot {
        animation: none;
      }
    }
  `;

  const veil = document.createElement("div");
  veil.className = "miru-veil";

  bannerEl = document.createElement("div");
  bannerEl.className = "miru-banner";
  bannerEl.innerHTML = `
    <span class="miru-banner-dot"></span>
    <div class="miru-banner-copy">
      <span class="miru-banner-title"></span>
      <span class="miru-banner-sub"></span>
    </div>
  `;

  targetBoxEl = document.createElement("div");
  targetBoxEl.className = "miru-target-box";
  targetBoxEl.hidden = true;

  targetLabelEl = document.createElement("div");
  targetLabelEl.className = "miru-target-label";
  targetLabelEl.hidden = true;

  cursorEl = document.createElement("div");
  cursorEl.className = "miru-cursor";
  cursorEl.hidden = true;

  shadowRoot.append(style, veil, bannerEl, targetBoxEl, targetLabelEl, cursorEl);
  document.documentElement.appendChild(overlayHost);
  return shadowRoot;
}

function scheduleReposition(): void {
  if (repositionScheduled) {
    return;
  }
  repositionScheduled = true;
  requestAnimationFrame(() => {
    repositionScheduled = false;
    if (activeSelector) {
      positionTargetBox(activeSelector);
    }
  });
}

function bindRepositionListeners(): void {
  if (listenersBound) {
    return;
  }
  listenersBound = true;
  window.addEventListener("scroll", scheduleReposition, true);
  window.addEventListener("resize", scheduleReposition);
}

function unbindRepositionListeners(): void {
  if (!listenersBound) {
    return;
  }
  listenersBound = false;
  window.removeEventListener("scroll", scheduleReposition, true);
  window.removeEventListener("resize", scheduleReposition);
}

function positionTargetBox(selector: string): void {
  if (!targetBoxEl || !targetLabelEl || !cursorEl) {
    return;
  }

  let element: Element | null = null;
  try {
    element = document.querySelector(selector);
  } catch {
    element = null;
  }

  if (!element) {
    targetBoxEl.hidden = true;
    targetLabelEl.hidden = true;
    cursorEl.hidden = true;
    return;
  }

  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 && rect.height <= 0) {
    targetBoxEl.hidden = true;
    targetLabelEl.hidden = true;
    cursorEl.hidden = true;
    return;
  }

  const pad = 4;
  targetBoxEl.hidden = false;
  targetBoxEl.style.top = `${Math.max(0, rect.top - pad)}px`;
  targetBoxEl.style.left = `${Math.max(0, rect.left - pad)}px`;
  targetBoxEl.style.width = `${rect.width + pad * 2}px`;
  targetBoxEl.style.height = `${rect.height + pad * 2}px`;

  const labelTop = Math.max(8, rect.top - 32);
  const labelLeft = Math.max(8, rect.left);
  targetLabelEl.hidden = false;
  targetLabelEl.style.top = `${labelTop}px`;
  targetLabelEl.style.left = `${labelLeft}px`;

  const targetX = rect.left + rect.width / 2;
  const targetY = rect.top + rect.height / 2;
  cursorEl.hidden = false;
  cursorEl.style.transform = `translate(${targetX}px, ${targetY}px)`;
  lastCursor = { x: targetX, y: targetY };
}

function moveCursorToPoint(point: CursorPoint, show: boolean): void {
  if (!cursorEl) {
    return;
  }
  if (!show) {
    cursorEl.hidden = true;
    return;
  }
  cursorEl.hidden = false;
  cursorEl.style.transform = `translate(${point.x}px, ${point.y}px)`;
  lastCursor = point;
}

export function teardownPageOverlay(): void {
  activeSelector = null;
  unbindRepositionListeners();
  overlayHost?.remove();
  overlayHost = null;
  shadowRoot = null;
  bannerEl = null;
  targetBoxEl = null;
  targetLabelEl = null;
  cursorEl = null;
}

export function applyPageOverlay(payload: PageAutomationOverlayPayload): void {
  if (!payload.active) {
    teardownPageOverlay();
    return;
  }

  ensureOverlayHost();
  bindRepositionListeners();

  const phase = payload.phase ?? "executing";
  const stepPrefix =
    payload.stepIndex !== undefined ? `Step ${payload.stepIndex}` : "";
  const title =
    payload.message?.trim() ||
    (stepPrefix ? `${stepPrefix} · ${AUTO_OVERLAY_BANNER}` : AUTO_OVERLAY_BANNER);
  const sub =
    payload.rationale?.trim() ||
    payload.stepTitle?.trim() ||
    PHASE_LABELS[phase];

  if (bannerEl) {
    const titleEl = bannerEl.querySelector(".miru-banner-title");
    const subEl = bannerEl.querySelector(".miru-banner-sub");
    if (titleEl) {
      titleEl.textContent = title;
    }
    if (subEl) {
      subEl.textContent = sub;
    }
  }

  const action = payload.action;
  if (!action) {
    activeSelector = null;
    targetBoxEl && (targetBoxEl.hidden = true);
    targetLabelEl && (targetLabelEl.hidden = true);
    moveCursorToPoint(lastCursor, false);
    return;
  }

  const label = actionOverlayLabel(action);
  if (targetLabelEl) {
    targetLabelEl.textContent = label;
  }

  const selector = actionTargetSelector(action);
  if (!selector) {
    activeSelector = null;
    if (targetBoxEl) {
      targetBoxEl.hidden = true;
    }
    if (targetLabelEl) {
      targetLabelEl.hidden = false;
      targetLabelEl.style.top = "72px";
      targetLabelEl.style.left = "50%";
      targetLabelEl.style.transform = "translateX(-50%)";
      targetLabelEl.textContent = label;
    }
    moveCursorToPoint({ x: window.innerWidth / 2, y: window.innerHeight / 2 }, phase !== "planning");
    return;
  }

  activeSelector = selector;
  if (targetLabelEl) {
    targetLabelEl.style.transform = "";
  }

  if (payload.cursor?.to && cursorEl) {
    const from = payload.cursor.from ?? lastCursor;
    moveCursorToPoint(from, true);
    window.setTimeout(() => {
      moveCursorToPoint(payload.cursor!.to, true);
    }, 40);
  }

  positionTargetBox(selector);

  if (phase === "executing" && cursorEl) {
    cursorEl.classList.add("is-clicking");
    window.setTimeout(() => cursorEl?.classList.remove("is-clicking"), 200);
  }

  (document.querySelector(selector) as HTMLElement | null)?.scrollIntoView({
    behavior: "smooth",
    block: "center",
  });
}
