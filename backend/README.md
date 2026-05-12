# Miru Backend MVP

This service is the first backend for Miru's planning loop.

It does three things:

- receives page context from the extension
- returns a structured next action
- stores session and planning history in Supabase when configured
- calls Groq for model-backed planning when configured

The backend also sends permissive CORS headers in the MVP so the Chrome extension can call it during local development.

## Why TypeScript

The extension already uses TypeScript. Keeping the backend in TypeScript makes it easier to share action schemas and keep the "structured actions, not JavaScript" contract consistent.

## MVP Scope

The MVP backend is intentionally narrow:

- `GET /health`
- `POST /v1/plan`
- Groq model-backed planner with structured outputs
- Supabase-backed session and plan persistence
- in-memory fallback when Supabase is not configured

That gives us an end-to-end demo now while keeping the extension-side action contract stable.

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
- `GROQ_API_KEY`
- `GROQ_MODEL`

If the Supabase values are missing, the backend still runs with in-memory storage for local demos.
If `GROQ_API_KEY` is missing, the backend cannot call the model-backed planner.

## Logging

Logs go to **stdout** as **JSON** (Pino). Each line includes a `msg` field (for example `→ POST /v1/plan/stream` on every request, then `POST /v1/plan/stream: start` / `plan resolved` / `complete` for the planner).

- Set **`LOG_LEVEL`** to `debug`, `info`, `warn`, or `error` (default `info`). If you set `LOG_LEVEL=silent` you will see almost nothing.
- If the extension uses the wrong `MIRU_BACKEND_URL`, you will see **no** planner traffic—only startup and maybe `/health`.

For human-readable logs in development, pipe through [pino-pretty](https://github.com/pinojs/pino-pretty): `npm run dev 2>&1 | npx pino-pretty` (install `pino-pretty` as a dev dependency if you want this often).

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

The next backend step is to tune the prompt and validation strategy so Miru can make stronger page decisions with the same response shape.
