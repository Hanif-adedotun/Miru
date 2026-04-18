# Miru Chrome Web Store Approval Guide

## Document Status

- Product: Miru
- Platform: Chrome Extension, Manifest V3
- Version: Draft 1
- Date: April 18, 2026

## 1. Why This Document Exists

Miru is likely to receive extra review scrutiny because it:

- reads page content
- may capture screenshots
- may send browsing context to a remote AI backend
- automates interactions on websites

This guide turns Chrome policy into concrete build and launch constraints.

## 2. Approval Risk Summary

The main approval risks are:

1. Broad permissions that exceed the stated purpose
2. Vague or multi-purpose positioning
3. Inadequate privacy and data-use disclosure
4. Any sign of remote code execution
5. Incomplete or misleading store listing metadata
6. Features that look like hidden surveillance rather than user-invoked tooling

## 3. Single-Purpose Positioning

Miru should be described as:

"A developer tool for inspecting, interacting with, and extracting data from the current webpage using page-aware automation."

Do not position Miru as:

- a general AI agent for the whole browser
- a personal browsing assistant
- a background browsing monitor
- a multi-purpose productivity extension

Why:

Chrome Web Store policy requires a single purpose that is narrow and easy to understand.

## 4. Permission Strategy To Maximize Approval Odds

### Best V1 Permission Set

- `activeTab`
- `scripting`
- `storage`

Avoid in V1 if possible:

- `"<all_urls>"` host permissions
- persistent host permissions
- unnecessary `tabs` usage
- background access patterns that are not user-triggered

Why:

- `activeTab` grants temporary access after a user gesture and avoids the install warning shown for broad host access
- broad host permissions make Miru look much riskier to both users and reviewers

## 5. Screenshot Capture Constraints

Miru can capture the visible tab with Chrome APIs after user invocation, but this is sensitive and should be narrowly used.

Build rules:

- capture only after explicit user action
- do not capture continuously
- do not capture unrelated tabs
- keep screenshots ephemeral by default
- disclose clearly when screenshots are sent to remote services

API limit:

- `chrome.tabs.captureVisibleTab()` has a documented max rate of 2 calls per second

## 6. HTML and Browsing Data Constraints

Miru can use page HTML and browsing activity only to support its user-facing purpose.

Build rules:

- collect only the active page needed for the active task
- do not collect browsing activity outside the user-facing workflow
- do not silently monitor pages in the background
- do not reuse captured content for unrelated analytics or advertising

Policy implication:

- Chrome policy restricts collection and use of web browsing activity except where required for a prominently described user-facing feature

## 7. Remote AI and Backend Constraints

Miru may send page context to a backend for inference, but it must not cross into remote code execution.

Allowed pattern:

- extension sends structured page data
- backend returns structured action data within a predefined schema
- extension validates and executes that schema locally

High-risk pattern to avoid:

- backend returns JavaScript to run
- backend returns command strings that act as arbitrary code
- extension interprets remote logic in a way that hides core functionality from review

For Chrome review, assume this principle:

- if a reviewer cannot understand the extension's real behavior from the packaged code plus disclosed backend usage, approval risk is high

## 8. Privacy and Disclosure Requirements

Before submission, Miru should have:

- a public privacy policy
- accurate Chrome Web Store privacy disclosures
- in-product disclosure that page content may be processed remotely
- clear permission justifications in the developer dashboard

If Miru handles user data, the privacy policy must explain:

- what data is collected
- why it is collected
- where it is sent
- who it is shared with
- how long it is retained
- how users can request deletion if applicable

For Miru, that likely includes:

- page HTML snippets
- visible screenshots
- extracted content
- prompts entered by the user
- telemetry if enabled

## 9. Store Listing Requirements

The Chrome Web Store listing should include:

- clear name
- accurate short description
- accurate long description
- screenshots that match real functionality
- icon
- privacy policy URL

Do not:

- overclaim site compatibility
- hide the remote AI component
- claim local-only processing if screenshots or HTML are sent to a backend

## 10. Technical Build Checklist

Miru should pass all of these before submission:

- Manifest V3 only
- no remotely hosted scripts
- no `eval` or equivalent dynamic execution
- no obfuscated code beyond normal minification
- permissions reduced to the minimum required
- no broken features or dead buttons
- extension behavior matches listing text

## 11. Practical Limits And Facts To Plan Around

As of April 18, 2026, the official Chrome docs state:

- maximum extension package upload size: 2 GB
- maximum published extensions per developer account by default: 20
- `storage.local` quota: 10 MB unless `unlimitedStorage` is requested
- `storage.session` quota: 10 MB
- `storage.sync` quota: about 100 KB, about 8 KB per item
- `captureVisibleTab` max rate: 2 calls per second

These are platform limits, not approval guarantees.

## 12. Strong Recommendation For Miru V1

To maximize approval odds, launch with:

- active-tab only access
- manual or guided action approval
- no continuous background capture
- no `"<all_urls>"` in the initial manifest if avoidable
- no arbitrary remote execution
- explicit data-use disclosure
- a narrow developer-tool positioning

## 13. Submission Checklist

Before upload:

- remove unused permissions
- verify all screenshots and listing text are accurate
- write a reviewer-friendly single-purpose statement
- fill out privacy fields carefully
- justify every permission
- declare remote code usage accurately as none, if Miru does not execute remote code
- verify backend responses are data, not executable logic
- test all visible flows end to end

## 14. Suggested Reviewer-Facing Purpose Statement

Suggested draft:

"Miru is a developer tool that helps users inspect the current webpage, capture page context such as HTML and the visible screenshot, and run constrained page interactions or extraction steps for debugging and scraping workflows."

## 15. Suggested Permission Justifications

`activeTab`

- Used to access the current page only after the user invokes the extension.

`scripting`

- Used to inject the Miru content script into the active tab so the extension can inspect the DOM and execute approved page actions.

`storage`

- Used to store user settings and temporary task session data.

`tabs`

- Only keep if needed.
- Used to identify the current active tab and manage the active Miru session.

## 16. Source Links

- Chrome Web Store program policies: https://developer.chrome.com/docs/webstore/program-policies/policies
- Privacy fields in the dashboard: https://developer.chrome.com/docs/webstore/cws-dashboard-privacy
- Publish in the Chrome Web Store: https://developer.chrome.com/docs/webstore/publish/
- Prepare your extension: https://developer.chrome.com/docs/webstore/prepare
- Single purpose FAQ: https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines-faq
- Limited Use policy: https://developer.chrome.com/docs/webstore/program-policies/limited-use
- Permission warning guidelines: https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings
- `activeTab` permission: https://developer.chrome.com/docs/extensions/activeTab
- Extension service worker basics: https://developer.chrome.com/docs/extensions/mv3/service_workers/basics
- Storage API reference: https://developer.chrome.com/docs/extensions/reference/storage
- Tabs API reference: https://developer.chrome.com/docs/extensions/reference/api/tabs
