import type { MiruAction, ScrapeArtifact, WorkflowStep } from "../types.js";
import { createId } from "../utils.js";

function normalizeRowStrings(row: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = value === null || value === undefined ? "" : String(value);
  }
  return out;
}

export function workflowStepTitle(action: MiruAction): string {
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

export function buildScrapeArtifact(stepId: string, action: MiruAction, result: unknown): ScrapeArtifact | null {
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
      id: createId(),
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
      id: createId(),
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
      .filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item)
      )
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
      id: createId(),
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

export function updateWorkflowStep(
  steps: WorkflowStep[],
  stepId: string,
  status: WorkflowStep["status"],
  resultSummary?: string,
  resultData?: unknown
): WorkflowStep[] {
  return steps.map((step) =>
    step.id === stepId
      ? {
          ...step,
          status,
          resultSummary,
          resultData,
          updatedAt: Date.now(),
        }
      : step
  );
}
