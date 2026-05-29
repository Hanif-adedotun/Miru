import {
  DEFAULT_PROMPT,
  MAX_HISTORY_ITEMS,
  SESSION_STORAGE_KEY,
} from "../shared/constants.js";
import type { ScrapeArtifact, SessionState } from "../shared/types.js";

const MAX_SCRAPE_ARTIFACTS = 40;
const MAX_ROWS_PER_SCRAPE_ARTIFACT = 1500;

export const ACTIVE_RUN_STORAGE_KEY = "miru-active-run";

export interface ActiveRunState {
  runId: string;
  lastAckSeq: number;
  tabId: number;
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

export function createEmptySession(): SessionState {
  return {
    id: null,
    runId: null,
    mode: "ask",
    prompt: DEFAULT_PROMPT,
    status: "idle",
    history: [],
    workflowSteps: [],
    chatMessages: [
      {
        id: crypto.randomUUID(),
        role: "assistant",
        content:
          "Describe the crawl or extraction flow you want. Miru will think in chat, run commands on the page, and can record the session as an exportable script.",
        status: "complete",
        createdAt: Date.now(),
      },
    ],
    isRecording: false,
    scrapeArtifacts: [],
    pendingAsk: undefined,
    updatedAt: Date.now(),
  };
}

export async function getStoredSession(): Promise<SessionState> {
  const result = await chrome.storage.session.get(SESSION_STORAGE_KEY);
  return (result[SESSION_STORAGE_KEY] as SessionState | undefined) ?? createEmptySession();
}

export async function saveSession(session: SessionState): Promise<SessionState> {
  const nextSession: SessionState = {
    ...session,
    history: session.history.slice(-MAX_HISTORY_ITEMS),
    workflowSteps: (session.workflowSteps ?? []).slice(-50),
    scrapeArtifacts: trimScrapeArtifacts(session.scrapeArtifacts),
    chatMessages: (session.chatMessages ?? []).slice(-30),
    updatedAt: Date.now(),
  };

  await chrome.storage.session.set({ [SESSION_STORAGE_KEY]: nextSession });
  return nextSession;
}

export async function clearSession(): Promise<void> {
  await chrome.storage.session.remove(SESSION_STORAGE_KEY);
  await chrome.storage.session.remove(ACTIVE_RUN_STORAGE_KEY);
}

export async function getActiveRun(): Promise<ActiveRunState | null> {
  const result = await chrome.storage.session.get(ACTIVE_RUN_STORAGE_KEY);
  return (result[ACTIVE_RUN_STORAGE_KEY] as ActiveRunState | undefined) ?? null;
}

export async function saveActiveRun(state: ActiveRunState | null): Promise<void> {
  if (!state) {
    await chrome.storage.session.remove(ACTIVE_RUN_STORAGE_KEY);
    return;
  }
  await chrome.storage.session.set({ [ACTIVE_RUN_STORAGE_KEY]: state });
}

export function isRunActive(session: SessionState): boolean {
  return Boolean(session.runId) && !["idle", "ready", "error", "complete"].includes(session.status);
}
