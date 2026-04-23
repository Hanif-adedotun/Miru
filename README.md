# Miru

AI-driven browser agent Chrome extension that lets users issue natural-language instructions and have an AI agent observe, scrape, and take actions on the currently active tab.

## Architecture

```
miru/
├─ src/
│  ├─ background/
│  │  └─ serviceWorker.ts        # Task orchestrator (no DOM access)
│  ├─ content/
│  │  └─ contentScript.ts        # DOM reader & executor
│  ├─ ui/
│  │  ├─ sidepanel.html
│  │  ├─ sidepanel.ts
│  │  ├─ sidepanel.css
│  │  ├─ app.ts
│  │  └─ app.css
│  ├─ shared/
│  │  ├─ types.ts                # Action schemas & message types
│  │  └─ constants.ts
│  └─ manifest.json
├─ public/
│  └─ icon.png
├─ package.json
├─ tsconfig.json
└─ README.md
```

## Setup

### 0. Add Extension Icon (Required)

Before building, you need to add an icon file:

1. Create or download a PNG icon (16x16, 48x48, and 128x128 pixels)
2. Save it as `public/icon.png`

**Quick placeholder option**: You can use any PNG image as a temporary placeholder. The extension will load without a proper icon, but Chrome may show warnings.

### 1. Install Dependencies

```bash
npm install
```

### 1.5 Configure The Backend URL

```bash
cp .env.example .env
```

Set `MIRU_BACKEND_URL` to the backend you want the extension to call.

For local development, the default is:

```bash
MIRU_BACKEND_URL=http://localhost:3001
```

### 2. Build the Extension

```bash
npm run build
```

This will:
- Generate the extension runtime config from `.env`
- Compile TypeScript files to JavaScript
- Copy manifest.json and public assets to `dist/`

### 3. Load Extension in Chrome

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top right)
3. Click "Load unpacked"
4. Select the `dist/` folder from this project
5. The Miru extension should now appear in your extensions list

### 4. Test the Extension

1. Navigate to any website (e.g., `https://example.com`)
2. Click the Miru extension icon in the Chrome toolbar
3. The Miru side panel should open
4. Start a session and you should see:
   - URL
   - Page title
   - Visible text length
   - Link count
   - Form count
   - Screenshot preview
   - HTML preview

## Documentation

- [Product Requirements Document](docs/PRD.md)
- [Chrome Extension Architecture](docs/ARCHITECTURE.md)
- [Chrome Web Store Approval Guide](docs/CHROME_WEB_STORE_APPROVAL.md)
- [Backend MVP Guide](backend/README.md)

## Development

### Watch Mode

```bash
npm run watch
```

This will automatically rebuild when you make changes to TypeScript files.

### Clean Build

```bash
npm run clean
npm run build
```

## File Structure

- **`src/background/serviceWorker.ts`**: Background service worker that orchestrates tasks and manages communication between the side panel and content scripts
- **`src/content/contentScript.ts`**: Content script injected into web pages to read DOM, extract page information, and execute actions
- **`src/ui/sidepanel.ts`**: Side panel entry point for the Miru session shell
- **`src/ui/app.ts`**: Shared side panel app renderer and interaction layer
- **`src/shared/types.ts`**: Shared type definitions including action schemas and message types
- **`src/shared/constants.ts`**: Shared constants used across the extension

## Messaging Flow

1. User clicks the extension icon and opens the side panel
2. The side panel sends session commands to the service worker
3. Service worker injects content script if needed
4. Content script reads page metadata and executes constrained actions
5. Service worker stores session state and returns updates
6. The side panel renders context, screenshots, and action history

## Permissions

The extension uses:
- `activeTab`: Access to the active tab when user interacts
- `scripting`: Inject content scripts
- `storage`: Store extension data (for future use)
- `tabs`: Query tab information
- `sidePanel`: Open Miru in Chrome's side panel

## Next Steps

This is the foundation. Future enhancements will include:
- AI planner integration
- Action execution (CLICK, TYPE, EXTRACT, etc.)
- Natural language instruction processing
- Action history and inspection

## License

MIT
