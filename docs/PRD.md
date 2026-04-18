# Miru Product Requirements Document

## Document Status

- Product: Miru
- Platform: Chrome Extension, Manifest V3
- Version: Draft 1
- Date: April 18, 2026

## 1. Product Summary

Miru is a developer tool for interacting with and scraping complex websites from a Chrome extension. It combines browser automation with page awareness. Miru can inspect the current page HTML and the current screenshot, build context from both, and then decide which JavaScript action to run next.

The core value is not raw automation alone. The value is context-aware automation that remains understandable to the user while it runs.

## 2. Problem Statement

Developers can automate websites with tools such as Playwright or Puppeteer, but those tools are harder to use when:

- the page is highly dynamic
- selectors are brittle or incomplete
- the next action depends on what is visibly rendered
- the developer wants to see the page being interacted with inside a real browser session

Miru should solve this by giving developers a browser-native tool that can observe page state, reason from what it sees, and execute narrow, inspectable actions.

## 3. Product Vision

Miru should feel like a visual browser operator for developers:

- it runs inside Chrome
- it interacts with the page the user is already viewing
- it exposes what it sees and what it plans to do
- it supports extraction and interaction on hard-to-script sites

## 4. Target Users

Primary users:

- developers building custom scraping workflows
- developers testing automation flows on real sites
- technical operators who need browser-visible extraction and action replay

Secondary users:

- internal tools teams
- data operations teams with JavaScript skills

## 5. Jobs To Be Done

When I need to collect data from a complex website, I want a browser tool that can inspect the rendered page, understand the current state, and perform the next action so that I can build a reliable scraper faster.

When I automate a site with brittle selectors, I want the tool to use screenshot and DOM context so that it can recover from layout shifts and dynamic UI changes.

When an automation runs, I want to see what the tool is doing so that I can trust, debug, and refine the workflow.

## 6. Core Value Proposition

Miru combines three capabilities in one product:

1. Page observation through HTML and screenshot capture
2. Controlled browser actions through a constrained JavaScript action layer
3. Visible execution so the developer can inspect and trust the workflow

## 7. Product Scope

### In Scope

- run as a Chrome extension on Manifest V3
- read the current page DOM and metadata after explicit user invocation
- capture the visible tab screenshot after explicit user invocation
- send page context to a planning layer
- return a structured next action or extraction plan
- execute approved page actions such as click, type, scroll, wait, and extract
- show users the current page state, planned action, and action result
- maintain session history for the current task
- allow manual confirmation for risky actions

### Out of Scope for V1

- background scraping across many tabs without user initiation
- persistent invisible surveillance of browsing activity
- fully autonomous long-running agents that navigate the web without user involvement
- credential vaulting
- bypassing site security controls or access controls
- support for file downloads, uploads, or payments without explicit gated UX
- remote execution of arbitrary JavaScript supplied by a server

## 8. Product Principles

- User-invoked: Miru acts after a clear user gesture.
- Inspectable: Miru shows the current state, proposed action, and result.
- Narrowly scoped: Miru is a developer browser interaction and extraction tool, not a general browsing assistant.
- Safe by default: Miru minimizes permissions, data retention, and automated risk.
- Chrome-reviewable: the full behavior must be understandable from the packaged extension code and disclosed product behavior.

## 9. Primary User Flow

1. User opens a target website in Chrome.
2. User opens the Miru extension UI.
3. User enters a prompt or starts a capture session.
4. Miru collects:
   - URL
   - title
   - relevant DOM snapshot
   - visible screenshot
   - optional recent action history
5. Miru sends a structured context payload to the planner.
6. Planner returns one of:
   - extract result
   - next proposed action
   - request for more context
   - failure explanation
7. Miru shows the proposed action and confidence.
8. User approves or Miru auto-runs based on the selected mode.
9. Miru executes the action on the page.
10. Miru refreshes context and repeats until the task completes or the user stops it.

## 10. User Modes

### Inspect Mode

Miru reads the page and shows structured context without taking action.

### Guided Mode

Miru proposes one action at a time and waits for approval.

### Run Mode

Miru executes low-risk actions automatically within a bounded task session.

V1 recommendation:

- ship Inspect Mode and Guided Mode first
- make Run Mode opt-in and limited to low-risk actions

## 11. Functional Requirements

### 11.1 Page Context Capture

Miru must:

- capture the active tab URL and title
- extract visible page text and relevant HTML structure
- capture the visible tab screenshot
- annotate the context with timestamp and frame information when available
- maintain action history for the current task

Miru should:

- trim and summarize HTML before sending it remotely
- avoid collecting unnecessary sensitive fields
- distinguish visible content from raw DOM noise where practical

### 11.2 Action Planning

Miru must:

- translate user intent into a structured plan
- constrain planner output to an allowlisted action schema
- reject unknown or unsafe action types
- maintain state across steps in a task session

Planner output should support:

- `QUERY`
- `CLICK`
- `TYPE`
- `SCROLL`
- `WAIT`
- `EXTRACT`
- `STOP`

### 11.3 Action Execution

Miru must:

- execute actions only against the active user-invoked tab
- surface execution status and errors
- support retries for transient failures
- refresh context after state-changing actions

Miru should:

- highlight the target element before or during execution
- support fallback targeting strategies beyond a single CSS selector in later versions

### 11.4 Extraction

Miru must:

- return structured extraction output
- allow field-based extraction requests
- show extracted data in the extension UI

Miru should:

- support JSON export in later versions
- support recipe-based extraction templates in later versions

### 11.5 Transparency and Control

Miru must:

- show what permissions it uses and why
- show current task status
- show the last captured screenshot or a screenshot preview
- show the latest DOM summary
- show the next planned action
- let the user stop a running task

### 11.6 Storage and Session Behavior

Miru must:

- store only the minimum session state needed for the current task
- separate transient task state from persistent settings
- allow users to clear session data

Miru should:

- keep screenshots ephemeral by default
- avoid storing full-page HTML unless explicitly enabled

## 12. Non-Functional Requirements

### Performance

- first context read should complete quickly after invocation
- action execution should feel near-real-time to the user
- screenshot capture frequency must stay within Chrome API limits

### Reliability

- Miru should recover from reinjection and transient message failures
- planner failures should not break the extension session
- unsupported pages should fail clearly

### Security

- no remote code execution
- no arbitrary `eval`
- no dynamic execution of server-returned JavaScript
- no hidden browsing collection outside the user-facing feature

### Privacy

- only collect data needed for the active user task
- disclose clearly when HTML, screenshots, or extracted content are sent to a remote AI service
- avoid collecting credentials, payment data, or unrelated tabs

## 13. UX Requirements

The extension UI should include:

- current tab summary
- screenshot preview state
- task prompt input
- action timeline
- action approval controls
- extraction result panel
- error and permission states

The UX should make these states obvious:

- idle
- capturing context
- planning
- waiting for approval
- executing
- success
- blocked
- failed

## 14. Success Metrics

V1 metrics:

- successful install and local use on supported sites
- task completion rate for common interaction flows
- extraction success rate on target sites
- average number of manual corrections per task
- median time from prompt to first useful action
- Chrome Web Store approval on first submission or after one revision cycle

## 15. Risks

- Chrome Web Store reviewers may view broad permissions and screenshot capture as high risk.
- Remote AI usage may trigger privacy and disclosure scrutiny.
- Reviewers may reject behavior that resembles remote command execution instead of constrained action planning.
- Dynamic websites may require more context than a popup-only UI can handle.
- Service worker lifecycle can interrupt longer sessions if state management is weak.

## 16. V1 Release Recommendation

V1 should be intentionally narrow:

- single clear purpose: developer page interaction and extraction
- active-tab only
- guided execution by default
- constrained action schema
- strong permission minimization
- clear in-product disclosure for screenshot, HTML, and remote AI processing

## 17. Open Decisions

- Should screenshots be stored locally at all, or used only in-memory?
- Should extraction and planning use one backend endpoint or separate services?
- Should auto-run be available in V1, or only after Guided Mode proves stable?
- Should Miru support all sites at launch, or only user-approved origins?
- Should HTML be full-document, visible-region only, or summarized DOM blocks?

