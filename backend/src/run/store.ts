import type { RunRecord } from "./types.js";

const runsById = new Map<string, RunRecord>();
const runIdByConnection = new Map<string, string>();

export function saveRun(run: RunRecord): void {
  runsById.set(run.runId, run);
  runIdByConnection.set(run.connectionId, run.runId);
}

export function getRun(runId: string): RunRecord | undefined {
  return runsById.get(runId);
}

export function getRunByConnection(connectionId: string): RunRecord | undefined {
  const runId = runIdByConnection.get(connectionId);
  if (!runId) {
    return undefined;
  }
  return runsById.get(runId);
}

export function deleteRun(runId: string): void {
  const run = runsById.get(runId);
  if (run) {
    runIdByConnection.delete(run.connectionId);
  }
  runsById.delete(runId);
}

export function clearConnection(connectionId: string): void {
  const runId = runIdByConnection.get(connectionId);
  if (runId) {
    const run = runsById.get(runId);
    if (run) {
      run.connectionId = "";
    }
    runIdByConnection.delete(connectionId);
  }
}
