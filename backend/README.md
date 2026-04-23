# Miru Backend MVP

This service is the first backend for Miru's planning loop.

It does three things:

- receives page context from the extension
- returns a structured next action
- stores session and planning history in Supabase when configured

The backend also sends permissive CORS headers in the MVP so the Chrome extension can call it during local development.

## Why TypeScript

The extension already uses TypeScript. Keeping the backend in TypeScript makes it easier to share action schemas and keep the "structured actions, not JavaScript" contract consistent.

## MVP Scope

The MVP backend is intentionally narrow:

- `GET /health`
- `POST /v1/plan`
- heuristic planner for the demo
- Supabase-backed session and plan persistence
- in-memory fallback when Supabase is not configured

That gives us an end-to-end demo now, and a clean place to swap in model inference next.

## Folder Structure

```text
backend/
├─ src/
│  ├─ config.ts
│  ├─ index.ts
│  ├─ planner.ts
│  ├─ routes.ts
│  ├─ storage.ts
│  ├─ types.ts
│  └─ utils.ts
├─ .env.example
├─ package.json
└─ tsconfig.json
```

## Environment

Copy `.env.example` to `.env` and fill in:

- `PORT`
- `HOST`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

If the Supabase values are missing, the backend still runs with in-memory storage for local demos.

## Local Run

```bash
cd backend
npm install
npm run dev
```

## API Contract

### `GET /health`

Returns the service status and whether persistence is using Supabase or memory.

### `POST /v1/plan`

Request:

```json
{
  "prompt": "Extract the main heading and first link",
  "mode": "ask",
  "context": {
    "url": "https://example.com",
    "title": "Example Domain",
    "visibleTextLength": 120,
    "linkCount": 1,
    "formCount": 0,
    "htmlPreview": "<main><h1>Example Domain</h1></main>",
    "interactiveElements": [
      {
        "selector": "a[href]",
        "label": "More information",
        "tagName": "a"
      }
    ],
    "timestamp": 1713820000000
  }
}
```

Response:

```json
{
  "sessionId": "0a6b8d6e-4a44-4225-8a17-7d9a86e4cbf3",
  "proposedAction": {
    "id": "ed4be8fe-d06a-4f68-9b66-c1c7578fbbab",
    "action": {
      "type": "EXTRACT",
      "fields": [
        { "name": "pageTitle", "selector": "title" },
        { "name": "primaryHeading", "selector": "h1" },
        { "name": "firstPrimaryLink", "selector": "a[href]" }
      ]
    },
    "rationale": "The prompt asks for structured data, so the planner starts with a narrow extraction set that is easy to inspect.",
    "confidence": 0.66,
    "risk": "low",
    "requiresConfirmation": false
  },
  "memory": {
    "previousPlans": 1,
    "storedInSupabase": true
  }
}
```

## Supabase Schema

Apply the SQL migration in [supabase/migrations/20260422_init_miru_backend.sql](/Users/hanif/Documents/open-source/Miru/supabase/migrations/20260422_init_miru_backend.sql).

## Next Step

The next backend step is to replace the heuristic planner with a model-backed planner while keeping the exact same response shape.
