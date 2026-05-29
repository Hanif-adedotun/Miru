import type { MiruMode, ProposedAction } from "../types.js";

export function shouldAutoExecute(mode: MiruMode, action: ProposedAction): boolean {
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

export function isTerminalAction(action: ProposedAction): boolean {
  return action.action.type === "STOP";
}
