/**
 * Helpers for page automation overlay (auto mode).
 */

import type { MiruAction } from "../types.js";

export type PageOverlayPhase =
  | "planning"
  | "preview"
  | "executing"
  | "waiting"
  | "idle";

export interface OverlayCursorHint {
  from?: { x: number; y: number };
  to: { x: number; y: number };
  animateMs?: number;
}

export interface PageAutomationOverlayPayload {
  active: boolean;
  phase?: PageOverlayPhase;
  message?: string;
  action?: MiruAction;
  rationale?: string;
  stepIndex?: number;
  stepTotal?: number;
  stepTitle?: string;
  runStatus?: string;
  cursor?: OverlayCursorHint;
}

export const AUTO_OVERLAY_BANNER =
  "Miru is performing autonomous actions";

export function actionOverlayLabel(action: MiruAction): string {
  switch (action.type) {
    case "QUERY":
      return `Inspect · ${action.selector}`;
    case "CLICK":
      return `Click · ${action.selector}`;
    case "TYPE":
      return `Type · ${action.selector}`;
    case "SCROLL":
      return action.direction === "to"
        ? `Scroll to ${action.amount ?? 0}px`
        : `Scroll ${action.direction}${action.amount ? ` ${action.amount}px` : ""}`;
    case "WAIT":
      return `Wait ${action.durationMs}ms`;
    case "EXTRACT":
      return `Extract · ${action.fields.map((f) => f.name).join(", ")}`;
    case "EXTRACT_LIST":
      return `Extract list · ${action.itemSelector}`;
    case "STOP":
      return `Stop · ${action.reason}`;
    default:
      return action.type;
  }
}
