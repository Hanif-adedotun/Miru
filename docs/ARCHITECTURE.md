# Miru Chrome Extension Architecture

## Document Status

- Product: Miru
- Platform: Chrome Extension, Manifest V3
- Version: Draft 1
- Date: April 18, 2026

## 1. Goal

This document translates the product requirements into a buildable Manifest V3 extension architecture.

Miru should be implemented as a workflow-first browser automation system. The architecture should support:

- building a continuous stream of constrained browser commands
- exposing those commands through a readable chat transcript
- refining that workflow as page state changes
- replaying a successful workflow as a reusable extraction routine
- repairing a workflow when the target site drifts
- exporting a recorded session as executable JavaScript scaffolding

## 2. Current Repo Shape

The current project already matches a basic MV3 structure:

- `src/background/serviceWorker.ts`
- `src/content/contentScript.ts`
- `src/ui/sidepanel.html`
- `src/ui/sidepanel.ts`
- `src/shared/types.ts`
- `src/manifest.json`

That is a good foundation, but Miru will need a clearer separation between capture, workflow planning, command execution, routine storage, and policy boundaries.

## 3. Recommended V1 Architecture

### Extension Components

#### Side Panel UI

Responsibilities:

- chat transcript
- task input
- task status
- inline page memory summaries
- command approval controls
- workflow timeline
- recording controls
- JavaScript export affordance
- routine save and replay affordances
- extracted result display

Notes:

- primary Miru shell for task sessions
- remains visible while the page changes
- should feel like a compact conversational operator console rather than a dashboard

#### Background Service Worker

Responsibilities:

- session orchestration
- state transitions
- permission-aware routing
- API calls to backend workflow planner
- chat message creation and update
- command stream management
- recording lifecycle management
- export script generation
- routine replay coordination
- retry and error handling
- storage coordination

Constraints:

- no DOM access
- lifecycle is event-driven and non-persistent
- must persist minimal session state outside in-memory globals

#### Content Script

Responsibilities:

- DOM inspection
- element lookup
- command execution on the current page
- visible text extraction
- element highlighting

Constraints:

- runs in page context boundaries
- must avoid unsafe execution patterns
- should operate from structured command payloads only

#### Remote Backend

Responsibilities:

- authenticate user session
- receive structured page context
- run model inference
- return constrained command output
- refine workflow state across steps
- support routine-aware planning and repair
- log task telemetry if enabled

Critical rule:

- backend may return data, plans, workflow suggestions, and model output
- backend must not return arbitrary executable JavaScript for the extension to run

## 4. Data Flow

### Workflow Loop

1. User invokes Miru from the extension action.
2. Side panel requests a context capture.
3. Service worker:
   - verifies active tab access
   - captures screenshot
   - requests DOM summary from content script
4. Service worker builds a normalized workflow payload:
   - prompt
   - mode
   - current page context
   - prior command history
   - prior chat messages
   - prior results
   - optional routine metadata
5. Service worker sends the payload to backend planning.
6. Backend returns a structured next command or workflow refinement response.
7. Side panel displays the next command and the updated workflow timeline.
7. Side panel also renders a readable assistant message for the same step.
8. User approves if required.
9. Service worker forwards a structured command to the content script.
10. Content script executes the command and returns a result.
11. Service worker updates workflow state and triggers the next loop if needed.

### Routine Replay Loop

1. User selects a saved routine.
2. Service worker loads the routine definition and prior prompt context.
3. Miru runs the workflow against the current page or origin.
4. If commands fail due to site drift, backend planning attempts workflow repair within the constrained schema.
5. Miru surfaces any repaired step for inspection before the routine is updated.

## 5. Suggested Module Boundaries

Recommended additions:

- `src/background/sessionManager.ts`
- `src/background/plannerClient.ts`
- `src/background/chatManager.ts`
- `src/background/workflowManager.ts`
- `src/background/routineManager.ts`
- `src/background/exportManager.ts`
- `src/background/permissionManager.ts`
- `src/background/screenshot.ts`
- `src/content/domSnapshot.ts`
- `src/content/actionExecutor.ts`
- `src/content/elementLocator.ts`
- `src/shared/workflows.ts`
- `src/shared/routines.ts`
- `src/shared/schemas.ts`
- `src/shared/messages.ts`
- `src/shared/sanitizers.ts`

## 6. State Model

### Session State

Keep session state explicit and serializable:

- `sessionId`
- `tabId`
- `origin`
- `mode`
- `prompt`
- `chatMessages`
- `latestContext`
- `lastScreenshotAt`
- `commandHistory`
- `workflowSteps`
- `isRecording`
- `recordedSession`
- `lastExportedScript`
- `lastPlan`
- `lastExtraction`
- `status`
- `lastError`

### Routine State

Persist saved routines separately from transient sessions:

- `routineId`
- `name`
- `originPattern`
- `prompt`
- `workflowSteps`
- `lastSuccessfulRunAt`
- `lastRepairAt`
- `version`

### Suggested Runtime Shapes

Suggested workflow step shape:

```ts
type WorkflowStepStatus =
  | "planned"
  | "approved"
  | "running"
  | "succeeded"
  | "failed"
  | "repaired"
  | "skipped";

interface WorkflowStep {
  id: string;
  action: MiruAction;
  title: string;
  rationale?: string;
  status: WorkflowStepStatus;
  resultSummary?: string;
  createdAt: number;
  updatedAt: number;
}
```

Suggested chat message shape:

```ts
type ChatRole = "user" | "assistant" | "system";
type ChatMessageStatus = "ready" | "thinking" | "running" | "complete" | "error";

interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  status: ChatMessageStatus;
  createdAt: number;
  relatedStepId?: string;
}
```

Suggested saved routine shape:

```ts
interface SavedRoutine {
  id: string;
  name: string;
  originPattern: string;
  prompt: string;
  workflowSteps: WorkflowStep[];
  version: number;
  lastSuccessfulRunAt?: number;
  lastRepairAt?: number;
}
```

Suggested recorded session shape:

```ts
interface RecordedSession {
  id: string;
  prompt: string;
  workflowSteps: WorkflowStep[];
  startedAt: number;
  completedAt?: number;
}
```

Suggested planner payload additions:

```ts
interface PlannerRequest {
  sessionId?: string;
  prompt: string;
  mode: MiruMode;
  context: PageContext;
  history?: PlannerEvent[];
  chatMessages?: ChatMessage[];
  workflowSteps?: WorkflowStep[];
  routine?: SavedRoutine;
}
```

### Storage Recommendation

- `chrome.storage.session`: active workflow session state
- `chrome.storage.local`: settings, consent flags, lightweight routine metadata cache
- avoid `chrome.storage.sync` for session content or large payloads

Backend persistence recommendation:

- database `workflow_runs` table for transient or completed workflow sessions
- database `workflow_steps` table keyed to a run or routine
- database `saved_routines` table for replayable workflows
- database `routine_versions` table for repair history and auditability

Reason:

- `storage.session` survives service worker restarts within the browser session and fits MV3 well
- `storage.local` should be reserved for small persistent settings and lightweight routine references

## 7. Command Schema Design

Miru should never execute free-form code. Use a narrow schema.

Recommended V1 schema:

```ts
type MiruAction =
  | { type: "QUERY"; selector: string }
  | { type: "CLICK"; selector: string }
  | { type: "TYPE"; selector: string; text: string }
  | { type: "SCROLL"; direction: "up" | "down" | "to"; amount?: number }
  | { type: "WAIT"; durationMs: number }
  | { type: "EXTRACT"; fields: Array<{ name: string; selector: string; attr?: string }> }
  | { type: "STOP"; reason: string };
```

Recommended later additions:

- locator candidates
- frame hints
- confidence
- reason
- requiresConfirmation

This schema should represent the atomic command layer, not the entire workflow. Workflows are ordered lists of these constrained commands plus execution metadata.

## 8. Screenshot Capture

Use `chrome.tabs.captureVisibleTab()` after user invocation.

Implementation notes:

- throttle captures aggressively
- use capture only when the task starts or after state-changing commands
- avoid continuous capture loops
- store screenshots in memory or temporary state by default

Chrome API constraint:

- `captureVisibleTab` has a documented max rate of 2 calls per second

## 9. DOM Capture Strategy

Do not send raw full-document HTML by default.

Recommended V1 capture:

- page URL
- title
- viewport size
- visible text blocks
- interactive elements
- forms and inputs
- candidate targets near the last acted element
- trimmed HTML snippets for relevant regions
- current workflow step context when relevant

Sanitization:

- redact password fields
- avoid hidden input values unless explicitly needed and user-approved
- trim very long text blocks
- drop script and style content

## 10. Permissions Strategy

### Recommended V1 Permissions

- `activeTab`
- `scripting`
- `storage`

Optional:

- `tabs` only if still required after implementation review

Recommendation:

- remove `"<all_urls>"` from `host_permissions` for V1 if the extension is user-invoked on the active tab
- use optional host permissions only if a later feature needs durable site access

Reason:

- the current manifest asks for broad host access
- Miru's user-facing model is much easier to defend in review if access is temporary and user-invoked

## 11. Security Requirements

Miru must not:

- execute backend-returned JavaScript
- use `eval`, `new Function`, or similar dynamic execution
- load remotely hosted scripts into the extension
- hide capability behind obfuscated code

Miru must:

- validate planner output against a local schema
- log rejected action payloads
- gate sensitive actions
- use HTTPS for backend traffic
- keep workflow replay bounded to the active user-invoked tab or approved origin model

## 12. Privacy Requirements

Miru should implement:

- first-run disclosure for screenshot and HTML processing
- per-session indication that page content may be sent to backend AI
- user setting to disable screenshot capture
- user setting to clear local session history
- user setting to clear saved routine metadata if stored locally

If Miru processes user data remotely, it will also need:

- public privacy policy
- accurate Chrome Web Store privacy disclosures
- clear statement of retention and sharing

## 13. UX Gating For Risky Actions

Always require explicit approval for:

- typing into password or payment-related fields
- multi-step form submission
- clicking destructive controls
- navigation away from the current origin
- routine repairs that materially change saved workflow behavior

Later, if auto-run is added, create a strict allowlist for actions that can run without confirmation.

## 14. Error Handling

Expected failure classes:

- no active tab
- restricted page
- content script injection failure
- selector not found
- frame mismatch
- planner timeout
- backend unavailable
- permission denied
- routine replay drift
- workflow repair failure

The UI should surface the exact failure class and the suggested next step.

## 15. Release Phases

### Phase 0

- page summary
- selector query
- element highlight

### Phase 1

- screenshot capture
- planner integration
- guided command execution
- extraction results
- workflow timeline

### Phase 2

- session memory
- retries and recovery
- better locator strategy
- side panel
- save workflow as reusable routine

### Phase 3

- routine versioning and repair
- templates and saved routines
- origin-scoped automation presets
- richer debugging tools

## 16. Testing Plan

Test layers:

- unit tests for schemas, sanitizers, and planner response validation
- integration tests for service worker and content script messaging
- integration tests for workflow replay and routine repair paths
- manual testing on:
  - static sites
  - SPA sites
  - pages with forms
  - pages with iframes
  - repeated runs on the same workflow
  - restricted pages that should fail safely

Pre-submission checks:

- verify permission prompts match product claims
- verify no remote code paths
- verify privacy disclosures match actual traffic
- verify saved routine behavior matches what the UI promises
