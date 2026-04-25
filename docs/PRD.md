# Miru Product Requirements Document

## Document Status

- Product: Miru
- Platform: Chrome Extension, Manifest V3
- Version: Draft 1
- Date: April 18, 2026

## 1. Product Summary

Miru is a chat-first developer tool for building, refining, and replaying browser interaction workflows from a Chrome extension. It is designed to replace low-level Selenium-style scripting for crawling and extraction on complex websites.

Miru combines browser automation with page awareness. A user should be able to describe a task in chat, watch Miru think, see the next command it plans to run, and then observe the page change in response. Behind that conversational interface, Miru builds a constrained command stream that can later be saved, replayed, repaired, and exported as executable JavaScript.

The core value is not one-off automation alone. The value is a premium conversational workflow authoring experience for developers: visible, inspectable, reusable browser procedures without hand-writing brittle crawling code.

## 2. Problem Statement

Developers can automate websites with tools such as Selenium, Playwright, or Puppeteer, but those tools become painful when:

- the page is highly dynamic
- selectors are brittle or incomplete
- the next action depends on what is visibly rendered
- the workflow needs repeated refinement across runs
- the developer wants to see the page being interacted with inside a real browser session
- the end goal is a reusable crawl or extraction flow rather than a one-off action

Miru should solve this by giving developers a browser-native tool that can observe page state, reason from what it sees, build and refine a continuous stream of commands, and replay that stream as a reusable browser procedure.

## 3. Product Vision

Miru should feel like a chat-based browser operator for browser extraction:

- it runs inside Chrome
- it interacts with the page the user is already viewing
- it exposes what it sees, what it is thinking, what command it plans to run next, and how the workflow evolves
- it supports extraction and interaction on hard-to-script sites
- it turns successful sessions into reusable routines
- it can export a recorded session as JavaScript

## 4. Target Users

Primary users:

- developers building custom scraping workflows
- developers testing automation flows on real sites
- technical operators who need browser-visible extraction and action replay

Secondary users:

- internal tools teams
- data operations teams with JavaScript skills

## 5. Jobs To Be Done

When I need to collect data from a complex website, I want a browser tool that can inspect the rendered page, understand the current state, and build the next command in a workflow so that I can create a reliable scraper faster.

When I automate a site with brittle selectors, I want the tool to use screenshot and DOM context so that it can recover from layout shifts and dynamic UI changes.

When an automation runs, I want to see what the tool is doing so that I can trust, debug, and refine the command stream.

When I discover a working extraction flow, I want to save and rerun it without rewriting Selenium code so that I can turn exploration into a repeatable procedure.

## 6. Core Value Proposition

Miru combines three capabilities in one product:

1. Page observation through HTML and screenshot capture
2. Controlled browser actions through a constrained command stream
3. Visible execution and refinement so the developer can inspect, improve, and replay the workflow

## 7. Product Scope

### In Scope

- run as a Chrome extension on Manifest V3
- provide a chat-first UI with a fixed composer and readable assistant responses
- read the current page DOM and metadata after explicit user invocation
- capture the visible tab screenshot after explicit user invocation
- send page context and workflow state to a planning layer
- return a structured next command or extraction plan
- execute approved page actions such as click, type, scroll, wait, and extract
- maintain a visible chat transcript for the current workflow
- show assistant states such as thinking, planning, running, and result
- let users refine a workflow after each step or run
- promote a successful session into a reusable extraction routine
- allow the user to record a session
- export a recorded session as executable JavaScript scaffolding
- rerun a saved or generated command stream against the same site pattern
- show users the current page state, planned command, and action result
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
- full no-code web scraping product for non-technical users

## 8. Product Principles

- User-invoked: Miru acts after a clear user gesture.
- Inspectable: Miru shows the current state, proposed command, and result.
- Workflow-first: Miru should help developers build and refine repeatable browser procedures, not just take isolated actions.
- Chat-first: the primary user-facing interface should be a readable conversation, not a dashboard.
- Narrowly scoped: Miru is a developer browser interaction and extraction tool, not a general browsing assistant.
- Safe by default: Miru minimizes permissions, data retention, and automated risk.
- Chrome-reviewable: the full behavior must be understandable from the packaged extension code and disclosed product behavior.

## 9. Primary User Flow

1. User opens a target website in Chrome.
2. User opens the Miru extension UI.
3. User enters a task prompt in chat.
4. Miru collects:
   - URL
   - title
   - relevant DOM snapshot
   - visible screenshot
   - recent workflow history
5. Miru sends a structured context payload and workflow state to the planner.
6. Planner returns one of:
   - next proposed command
   - workflow refinement suggestion
   - request for more context
   - failure explanation
7. Miru renders a readable assistant response, including thinking state, next command, and confidence.
8. User approves or Miru auto-runs based on the selected mode.
9. Miru executes the command on the page.
10. Miru refreshes context, appends the result to the chat and workflow timeline, and repeats until the task completes or the user stops it.
11. User refines the command stream if needed.
12. User saves the resulting workflow as a reusable routine for future extraction runs.
13. If the session was recorded, user exports it as executable JavaScript scaffolding.

## 10. Product Workflow Model

Miru should treat browser automation as a workflow lifecycle:

1. Explore: inspect the page and propose a safe next command
2. Build: assemble a continuous stream of commands
3. Refine: adjust commands as the page or site behavior becomes clearer
4. Extract: collect structured data from the page
5. Replay: rerun the workflow as a repeatable routine
6. Repair: update the workflow when the target site changes

## 11. User Modes

### Inspect Mode

Miru reads the page and shows structured context without taking action.

### Guided Mode

Miru proposes one command at a time and waits for approval.

### Run Mode

Miru executes low-risk commands automatically within a bounded task session.

V1 recommendation:

- ship Inspect Mode and Guided Mode first
- make Run Mode opt-in and limited to low-risk actions

## 12. Functional Requirements

### 12.1 Page Context Capture

Miru must:

- capture the active tab URL and title
- extract visible page text and relevant HTML structure
- capture the visible tab screenshot
- annotate the context with timestamp and frame information when available
- maintain command history for the current task

Miru should:

- trim and summarize HTML before sending it remotely
- avoid collecting unnecessary sensitive fields
- distinguish visible content from raw DOM noise where practical

### 12.2 Workflow Planning

Miru must:

- translate user intent into a structured command stream
- constrain planner output to an allowlisted action schema
- reject unknown or unsafe action types
- maintain state across steps in a task session
- support iterative planning based on prior commands and results

Planner output should support:

- `QUERY`
- `CLICK`
- `TYPE`
- `SCROLL`
- `WAIT`
- `EXTRACT`
- `STOP`

### 12.3 Command Execution

Miru must:

- execute commands only against the active user-invoked tab
- surface execution status and errors
- support retries for transient failures
- refresh context after state-changing commands

Miru should:

- highlight the target element before or during execution
- support fallback targeting strategies beyond a single CSS selector in later versions

### 12.4 Workflow Authoring And Refinement

Miru must:

- show the current command stream in execution order
- keep a readable chat transcript alongside the command stream
- let the user review the result of each command
- allow a later planner step to refine the workflow based on earlier results
- make it clear when a command was added, changed, skipped, or failed

Miru should:

- let users annotate steps
- let users rerun from a selected step in later versions

### 12.5 Extraction

Miru must:

- return structured extraction output
- allow field-based extraction requests
- show extracted data in the extension UI
- allow extraction commands to become part of a saved workflow

Miru should:

- support JSON export in later versions
- support recipe-based extraction templates in later versions

### 12.6 Replayable Routines

Miru must:

- allow a successful workflow session to be saved as a reusable routine
- preserve the ordered command stream and prompt context for reruns
- support rerunning the routine against the same target site pattern
- support creating a routine from a recorded chat session

Miru should:

- allow a rerun to produce a repaired workflow when selectors drift
- distinguish between exploratory sessions and reusable routines

### 12.7 Transparency and Control

Miru must:

- show what permissions it uses and why
- show current task status
- show the last captured screenshot or a screenshot preview
- show the latest DOM summary
- show the next planned command
- show the workflow timeline
- show readable assistant responses for each planned or executed step
- let the user stop a running task
- let the user start or stop recording a session
- let the user export a recorded session as JavaScript

### 12.8 Storage and Session Behavior

Miru must:

- store only the minimum session state needed for the current task
- separate transient task state from persistent settings
- allow users to clear session data
- separate temporary sessions from saved reusable routines

Miru should:

- keep screenshots ephemeral by default
- avoid storing full-page HTML unless explicitly enabled

## 13. Non-Functional Requirements

### Performance

- first context read should complete quickly after invocation
- action execution should feel near-real-time to the user
- screenshot capture frequency must stay within Chrome API limits

### Reliability

- Miru should recover from reinjection and transient message failures
- planner failures should not break the extension session
- unsupported pages should fail clearly
- rerun and replay should produce inspectable failure points when workflows drift

### Security

- no remote code execution
- no arbitrary `eval`
- no dynamic execution of server-returned JavaScript
- no hidden browsing collection outside the user-facing feature

### Privacy

- only collect data needed for the active user task
- disclose clearly when HTML, screenshots, or extracted content are sent to a remote AI service
- avoid collecting credentials, payment data, or unrelated tabs

## 14. UX Requirements

The extension UI should include:

- chat transcript
- fixed composer with task prompt input
- mode selector attached to the composer
- recording affordance
- workflow timeline or expandable step view
- action approval controls
- extraction result view
- saved-routine affordance
- export JavaScript affordance
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

The UX should make this mental model obvious:

- exploration becomes workflow
- workflow becomes reusable routine
- conversation becomes executable script

## 15. Success Metrics

V1 metrics:

- successful install and local use on supported sites
- task completion rate for common interaction flows
- extraction success rate on target sites
- average number of manual corrections per task
- median time from prompt to first useful command
- percentage of sessions that become reusable routines
- routine rerun success rate
- Chrome Web Store approval on first submission or after one revision cycle

## 16. Risks

- Chrome Web Store reviewers may view broad permissions and screenshot capture as high risk.
- Remote AI usage may trigger privacy and disclosure scrutiny.
- Reviewers may reject behavior that resembles remote command execution instead of constrained action planning.
- Dynamic websites need a side-panel-oriented UI so users can inspect context and approve actions without popup limits.
- Service worker lifecycle can interrupt longer sessions if state management is weak.
- Workflow repair may be harder than one-step planning when websites drift significantly.

## 17. V1 Release Recommendation

V1 should be intentionally narrow:

- single clear purpose: developer workflow authoring and extraction replay
- active-tab only
- guided execution by default
- constrained action schema
- strong permission minimization
- clear in-product disclosure for screenshot, HTML, and remote AI processing
- save successful sessions as reusable routines only after inspection

## 18. Open Decisions

- Should screenshots be stored locally at all, or used only in-memory?
- Should extraction and planning use one backend endpoint or separate services?
- Should auto-run be available in V1, or only after Guided Mode proves stable?
- Should Miru support all sites at launch, or only user-approved origins?
- Should HTML be full-document, visible-region only, or summarized DOM blocks?
- How should routines be versioned when the user repairs a broken workflow?
