import { AUTO_OVERLAY_BANNER, actionOverlayLabel } from "../shared/overlay.js";
import {
  RUN_MAX_STEPS,
  createRunEnvelope,
  type ClientActionResultPayload,
  type ClientRunStartPayload,
  type ClientUserAnswerPayload,
  type RunEnvelope,
  type ServerOverlayCommandPayload,
} from "../shared/run-protocol.js";
import type { FastifyInstance } from "fastify";

import { shouldAutoExecute, isTerminalAction } from "./gates.js";
import { buildScrapeArtifact, updateWorkflowStep, workflowStepTitle } from "./helpers.js";
import { clearConnection, deleteRun, getRun, saveRun } from "./store.js";
import type { RunPhase, RunRecord } from "./types.js";
import type {
  MiruAction,
  PageContext,
  PlanRequest,
  ProposedAction,
  SessionStatus,
  WorkflowStep,
} from "../types.js";
import { createId } from "../utils.js";

export type RunEmitFn = (envelope: RunEnvelope) => void;

const MAX_SCRAPE_ARTIFACTS = 40;

function sessionStatusFromPhase(phase: RunPhase): SessionStatus {
  switch (phase) {
    case "requesting_context":
      return "capturing";
    case "planning":
      return "planning";
    case "awaiting_approval":
      return "awaiting_approval";
    case "awaiting_input":
      return "awaiting_input";
    case "executing":
      return "executing";
    case "completed":
      return "ready";
    case "error":
      return "error";
    case "cancelled":
      return "ready";
    default:
      return "ready";
  }
}

function buildOverlayPayload(
  run: RunRecord,
  phase: ServerOverlayCommandPayload["phase"],
  action?: MiruAction,
  rationale?: string
): ServerOverlayCommandPayload {
  const stepIndex = run.workflowSteps.length;
  return {
    active: phase !== "idle",
    phase,
    message:
      phase === "planning"
        ? `Step ${stepIndex + 1} · Planning…`
        : stepIndex > 0
          ? `Step ${stepIndex} · ${AUTO_OVERLAY_BANNER}`
          : AUTO_OVERLAY_BANNER,
    action,
    rationale: rationale ?? (action ? actionOverlayLabel(action) : undefined),
    stepIndex: stepIndex > 0 ? stepIndex : 1,
    stepTitle: action ? workflowStepTitle(action) : undefined,
    runStatus: run.phase,
  };
}

function trimArtifacts(artifacts: RunRecord["scrapeArtifacts"]): RunRecord["scrapeArtifacts"] {
  return artifacts.slice(-MAX_SCRAPE_ARTIFACTS);
}

export class RunOrchestrator {
  constructor(
    private readonly app: FastifyInstance,
    private readonly connectionId: string,
    private readonly emit: RunEmitFn
  ) {}

  handleMessage(envelope: RunEnvelope): void {
    const { type, runId, payload } = envelope;

    switch (type) {
      case "client.run.start":
        void this.startRun(payload as ClientRunStartPayload);
        break;
      case "client.run.resume": {
        const p = payload as import("../shared/run-protocol.js").ClientRunResumePayload;
        const existing = getRun(p.runId);
        if (!existing) {
          this.emitError(runId, "Run not found for resume.");
          return;
        }
        existing.connectionId = this.connectionId;
        saveRun(existing);
        this.emitToRun(existing, "server.run.started", {
          runId: existing.runId,
          sessionId: existing.sessionId,
        });
        void this.requestContext(existing);
        break;
      }
      case "client.context.snapshot":
        void this.onContextSnapshot(runId, payload as { pageContext: PageContext; screenshotOmitted?: boolean });
        break;
      case "client.context.screenshot":
        void this.onContextScreenshot(runId, payload as { screenshotDataUrl: string });
        break;
      case "client.action.result":
        void this.onActionResult(runId, payload as ClientActionResultPayload);
        break;
      case "client.run.approve":
        void this.onApprove(runId, payload as { stepId: string });
        break;
      case "client.user.answer":
        void this.onUserAnswer(runId, payload as ClientUserAnswerPayload);
        break;
      case "client.run.cancel":
        void this.cancelRun(runId, (payload as { reason?: string })?.reason);
        break;
      default:
        break;
    }
  }

  handleDisconnect(): void {
    clearConnection(this.connectionId);
  }

  private nextSeq(run: RunRecord): number {
    run.seq += 1;
    return run.seq;
  }

  private emitToRun<T extends RunEnvelope["type"]>(
    run: RunRecord,
    type: T,
    payload: RunEnvelope<T>["payload"]
  ): void {
    const envelope = createRunEnvelope(type, run.runId, payload, this.nextSeq(run));
    run.updatedAt = Date.now();
    saveRun(run);
    this.emit(envelope);
  }

  private emitError(runId: string, message: string): void {
    const envelope = createRunEnvelope(
      "server.run.error",
      runId,
      { message, lastError: message },
      0
    );
    this.emit(envelope);
    const run = getRun(runId);
    if (run) {
      run.phase = "error";
      run.lastError = message;
      saveRun(run);
    }
  }

  private async startRun(payload: ClientRunStartPayload): Promise<void> {
    const runId = createId();
    const sessionId = createId();
    const run: RunRecord = {
      runId,
      sessionId,
      connectionId: this.connectionId,
      mode: payload.mode,
      prompt: payload.prompt.trim(),
      tabId: payload.tabId,
      origin: payload.origin,
      url: payload.url,
      phase: "starting",
      workflowSteps: [],
      chatMessages: [
        {
          id: createId(),
          role: "user",
          content: payload.prompt.trim(),
          status: "complete",
          createdAt: Date.now(),
        },
      ],
      scrapeArtifacts: [],
      waitKind: null,
      stepCount: 0,
      seq: 0,
      cancelled: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    saveRun(run);
    this.emitToRun(run, "server.run.started", { runId, sessionId });
    await this.requestContext(run);
  }

  private async requestContext(run: RunRecord): Promise<void> {
    if (run.cancelled) {
      return;
    }
    run.phase = "requesting_context";
    run.waitKind = "context";
    run.pendingScreenshot = undefined;
    this.emitToRun(run, "server.run.status", {
      status: "requesting_context",
      sessionStatus: sessionStatusFromPhase(run.phase),
      label: "Reading the page",
    });
    this.emitToRun(run, "server.overlay.command", buildOverlayPayload(run, "planning"));
    this.emitToRun(run, "server.context.request", { reason: "plan_cycle" });
  }

  private async onContextScreenshot(
    runId: string,
    payload: { screenshotDataUrl: string }
  ): Promise<void> {
    const run = getRun(runId);
    if (!run || run.waitKind !== "context") {
      return;
    }
    run.pendingScreenshot = payload.screenshotDataUrl;
    if (run.currentContext) {
      run.currentContext = {
        ...run.currentContext,
        screenshotDataUrl: payload.screenshotDataUrl,
      };
      await this.planNext(run);
    }
  }

  private async onContextSnapshot(
    runId: string,
    payload: { pageContext: PageContext; screenshotOmitted?: boolean }
  ): Promise<void> {
    const run = getRun(runId);
    if (!run || run.waitKind !== "context") {
      return;
    }

    run.currentContext = { ...payload.pageContext };
    if (payload.screenshotOmitted) {
      return;
    }
    await this.planNext(run);
  }

  private async planNext(run: RunRecord): Promise<void> {
    if (run.cancelled) {
      return;
    }

    if (run.stepCount >= RUN_MAX_STEPS) {
      await this.completeRun(run, `Stopped after ${RUN_MAX_STEPS} steps.`);
      return;
    }

    if (!run.currentContext) {
      this.emitError(run.runId, "No page context available for planning.");
      return;
    }

    run.phase = "planning";
    run.waitKind = null;
    this.emitToRun(run, "server.run.status", {
      status: "planning",
      sessionStatus: "planning",
      label: "Miru is thinking",
    });
    this.emitToRun(run, "server.overlay.command", buildOverlayPayload(run, "planning"));

    const messageId = createId();
    this.emitToRun(run, "server.chat.start", { messageId });

    const planRequest: PlanRequest = {
      sessionId: run.sessionId,
      prompt: run.prompt,
      mode: run.mode,
      context: run.currentContext,
      workflowSteps: run.workflowSteps,
      chatMessages: run.chatMessages,
    };

    try {
      const proposedAction = await this.app.planner.plan(planRequest);

      await this.app.planner.streamAlignedNarration(planRequest, proposedAction, (token) => {
        this.emit(
          createRunEnvelope("server.chat.token", run.runId, { messageId, token }, run.seq + 1)
        );
      });

      this.emitToRun(run, "server.chat.done", { messageId });

      const assistantMessage: import("../types.js").ChatMessage = {
        id: messageId,
        role: "assistant",
        content: proposedAction.rationale,
        status: "complete",
        createdAt: Date.now(),
        relatedStepId: proposedAction.id,
      };
      run.chatMessages = [...run.chatMessages, assistantMessage].slice(-30);

      await this.handlePlannedAction(run, proposedAction, messageId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Planning failed.";
      this.emitToRun(run, "server.chat.done", { messageId, error: message });
      run.phase = "error";
      run.lastError = message;
      this.emitToRun(run, "server.run.error", { message, lastError: message });
      saveRun(run);
    }
  }

  private async handlePlannedAction(
    run: RunRecord,
    proposedAction: ProposedAction,
    messageId: string
  ): Promise<void> {
    const stepIndex = run.workflowSteps.length + 1;
    const isAsk = proposedAction.action.type === "ASK_USER";
    const willAutoRun = !isAsk && shouldAutoExecute(run.mode, proposedAction);

    const workflowStep: WorkflowStep = {
      id: proposedAction.id,
      action: proposedAction.action,
      title: workflowStepTitle(proposedAction.action),
      rationale: proposedAction.rationale,
      status: willAutoRun ? "running" : "planned",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    run.workflowSteps = [...run.workflowSteps, workflowStep];
    run.pendingAction = proposedAction;
    run.stepCount += 1;

    this.emitToRun(run, "server.step.planned", {
      step: workflowStep,
      proposedAction,
      messageId,
      stepIndex,
    });

    this.emitToRun(
      run,
      "server.overlay.command",
      buildOverlayPayload(run, "preview", proposedAction.action, proposedAction.rationale)
    );

    if (isAsk && proposedAction.action.type === "ASK_USER") {
      const askAction = proposedAction.action;
      run.phase = "awaiting_input";
      run.waitKind = "answer";
      run.pendingAsk = {
        stepId: proposedAction.id,
        question: askAction.question,
        options: askAction.options,
        createdAt: Date.now(),
      };
      run.pendingAction = undefined;
      run.workflowSteps = updateWorkflowStep(
        run.workflowSteps,
        proposedAction.id,
        "skipped",
        askAction.question
      );
      this.emitToRun(run, "server.run.status", {
        status: "awaiting_input",
        sessionStatus: "awaiting_input",
      });
      this.emitToRun(run, "server.ask.user", {
        stepId: proposedAction.id,
        pendingAsk: run.pendingAsk,
      });
      this.emitToRun(
        run,
        "server.overlay.command",
        buildOverlayPayload(run, "waiting", askAction, askAction.question)
      );
      return;
    }

    if (!willAutoRun) {
      run.phase = "awaiting_approval";
      run.waitKind = "approval";
      this.emitToRun(run, "server.run.status", {
        status: "awaiting_approval",
        sessionStatus: "awaiting_approval",
        label: "Waiting for your approval",
      });
      this.emitToRun(run, "server.run.awaiting_approval", {
        stepId: proposedAction.id,
        proposedAction,
        stepIndex,
      });
      this.emitToRun(
        run,
        "server.overlay.command",
        buildOverlayPayload(run, "waiting", proposedAction.action, proposedAction.rationale)
      );
      return;
    }

    await this.executeStep(run, proposedAction, stepIndex);
  }

  private async onApprove(runId: string, payload: { stepId: string }): Promise<void> {
    const run = getRun(runId);
    if (!run || run.waitKind !== "approval" || !run.pendingAction) {
      return;
    }
    if (run.pendingAction.id !== payload.stepId) {
      return;
    }
    const stepIndex = run.workflowSteps.findIndex((s) => s.id === payload.stepId) + 1;
    await this.executeStep(run, run.pendingAction, stepIndex || run.workflowSteps.length);
  }

  private async onUserAnswer(
    runId: string,
    payload: { stepId: string; answer: string }
  ): Promise<void> {
    const run = getRun(runId);
    if (!run || run.waitKind !== "answer") {
      return;
    }

    run.prompt = payload.answer.trim();
    run.pendingAsk = undefined;
    run.waitKind = "context";
    const userMessage: import("../types.js").ChatMessage = {
      id: createId(),
      role: "user",
      content: payload.answer.trim(),
      status: "complete",
      createdAt: Date.now(),
      relatedStepId: payload.stepId,
    };
    run.chatMessages = [...run.chatMessages, userMessage].slice(-30);

    await this.requestContext(run);
  }

  private async executeStep(
    run: RunRecord,
    proposedAction: ProposedAction,
    stepIndex: number
  ): Promise<void> {
    run.phase = "executing";
    run.waitKind = "action_result";
    run.pendingAction = proposedAction;

    run.workflowSteps = updateWorkflowStep(run.workflowSteps, proposedAction.id, "running");

    this.emitToRun(run, "server.run.status", {
      status: "executing",
      sessionStatus: "executing",
      label: "Running step",
    });
    this.emitToRun(run, "server.step.running", { stepId: proposedAction.id, stepIndex });
    this.emitToRun(
      run,
      "server.overlay.command",
      buildOverlayPayload(run, "executing", proposedAction.action, proposedAction.rationale)
    );
    this.emitToRun(run, "server.step.execute", {
      stepId: proposedAction.id,
      action: proposedAction.action,
      stepIndex,
    });
  }

  private async onActionResult(runId: string, payload: ClientActionResultPayload): Promise<void> {
    const run = getRun(runId);
    if (!run || run.waitKind !== "action_result") {
      return;
    }

    const { stepId, result } = payload;
    const step = run.workflowSteps.find((s) => s.id === stepId);
    if (!step) {
      return;
    }

    const proposed = run.pendingAction;
    run.pendingAction = undefined;
    run.waitKind = null;

    const stepIndex = run.workflowSteps.findIndex((s) => s.id === stepId) + 1;

    if (result.success) {
      const artifact = proposed
        ? buildScrapeArtifact(stepId, proposed.action, result.result)
        : null;
      if (artifact) {
        run.scrapeArtifacts = trimArtifacts([...run.scrapeArtifacts, artifact]);
      }

      run.workflowSteps = updateWorkflowStep(
        run.workflowSteps,
        stepId,
        "succeeded",
        JSON.stringify(result.result ?? {}),
        result.result
      );

      const updatedStep = run.workflowSteps.find((s) => s.id === stepId)!;
      this.emitToRun(run, "server.step.completed", {
        step: updatedStep,
        stepIndex,
        scrapeArtifact: artifact ?? undefined,
      });

      if (proposed && isTerminalAction(proposed)) {
        const stopReason =
          proposed.action.type === "STOP" ? proposed.action.reason : undefined;
        await this.completeRun(run, stopReason);
        return;
      }

      await this.requestContext(run);
      return;
    }

    run.workflowSteps = updateWorkflowStep(
      run.workflowSteps,
      stepId,
      "failed",
      result.error ?? "Action failed"
    );
    run.phase = "error";
    run.lastError = result.error;
    const updatedStep = run.workflowSteps.find((s) => s.id === stepId)!;
    this.emitToRun(run, "server.step.completed", { step: updatedStep, stepIndex });
    this.emitToRun(run, "server.run.error", {
      message: result.error ?? "Action failed",
      lastError: result.error,
    });
    this.emitToRun(run, "server.overlay.command", { active: false, phase: "idle" });
    saveRun(run);
  }

  private async completeRun(run: RunRecord, reason?: string): Promise<void> {
    run.phase = "completed";
    run.waitKind = null;
    run.pendingAction = undefined;
    this.emitToRun(run, "server.run.status", {
      status: "completed",
      sessionStatus: "ready",
      label: reason ?? "Run complete",
    });
    this.emitToRun(run, "server.overlay.command", { active: false, phase: "idle" });
    this.emitToRun(run, "server.run.completed", {
      workflowSteps: run.workflowSteps,
      scrapeArtifacts: run.scrapeArtifacts,
      reason,
    });
    deleteRun(run.runId);
  }

  private cancelRun(runId: string, reason?: string): void {
    const run = getRun(runId);
    if (!run) {
      return;
    }
    run.cancelled = true;
    run.phase = "cancelled";
    this.emitToRun(run, "server.run.status", {
      status: "cancelled",
      sessionStatus: "ready",
      label: "Cancelled",
    });
    this.emitToRun(run, "server.overlay.command", { active: false, phase: "idle" });
    this.emitToRun(run, "server.run.completed", {
      workflowSteps: run.workflowSteps,
      scrapeArtifacts: run.scrapeArtifacts,
      reason: reason ?? "Cancelled by user",
    });
    deleteRun(run.runId);
  }
}

