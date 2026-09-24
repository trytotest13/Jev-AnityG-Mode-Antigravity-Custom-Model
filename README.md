<p align="center">
  <img src="icon.png" alt="Jev AnityG-Mode logo" width="120" />
</p>

<h1 align="center">Jev AnityG-Mode</h1>

<p align="center">
  <strong>Custom model support &amp; smart routing for Google Antigravity</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen?logo=node.js&logoColor=white" alt="Node.js ≥ 18" />
  <img src="https://img.shields.io/badge/typescript-6.x-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License" />
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" alt="Platform" />
</p>

---

## 📖 Table of Contents

1. [Overview](#-overview)
2. [Quick Start](#-quick-start)
3. [Adding Models](#-adding-models)
4. [Auto Router](#-auto-router)
5. [Dashboard](#-dashboard)
6. [Manual Build & Development](#-manual-build--development)
7. [How It Works](#-how-it-works)
8. [Project Structure](#-project-structure)
9. [Security & Privacy](#-security--privacy)
10. [Contributing](#-contributing)

---

## 🔭 Overview

By default, Google Antigravity only connects to Google's internal models. **Jev AnityG-Mode** routes requests through a lightweight local proxy so you can use **OpenAI**, **Anthropic**, **DeepSeek**, **Groq**, local **Ollama** instances, or any custom OpenAI-compatible endpoint, all directly inside the IDE model picker.

The built in **Auto (Smart Router)** mode inspects prompt contents (images, code snippets, context length) and routes each prompt to the best configured model, with automatic fallback when a provider fails.

---

## 🚀 Quick Start

### Prerequisites

1. **Node.js** v18 or later
2. **Google Antigravity** (classic app or Antigravity IDE 2.5+)

### Installation

```bash
# Clone the repository
git clone https://github.com/trytotest13/Antigravity-Custom-Model-AnityG-Mod.git
cd AnityG-Mod

# Run the installer (Windows)
install.bat
```

The installer will:

1. Detect your Antigravity installation (classic or IDE 2.5+).
2. Install dependencies and build the TypeScript source.
3. Back up original files (`app.asar.backup` / `.bak`).
4. Apply the patch and restart the IDE.

> **💡 After IDE updates:** Antigravity updates overwrite patched files. Simply run `install.bat` again after any update.

### Uninstalling

```bash
uninstall.bat
```

---

## ➕ Adding Models

| Installation Type | How to Add |
|---|---|
| **Classic App** | Open **Settings → Add Model** in the UI |
| **Antigravity IDE 2.5+** | Edit `%USERPROFILE%\.gemini\antigravity\custom_models.json` |

Once you have at least one custom model configured, **Auto (Smart Router)** automatically appears in the model selector.

---

## 🧠 Auto Router

Selecting **Auto (Smart Router)** routes each prompt dynamically based on its content:

| Capability | Behavior |
|---|---|
| **🖼️ Vision** | Directs requests containing images to vision capable models |
| **💻 Code** | Routes programming questions and stack traces to your best coding model |
| **📏 Context Size** | Selects models with large context windows for large files or long chats |
| **🔄 Fallbacks** | If a provider hits a rate limit or errors out, retries with the next suitable model |
| **🚑 Never stall switching** | "Prompt is too long" 400s (previously a dead end that terminated the agent), payment required 402, payload too large 413, and unprocessable 422 responses now switch models automatically. JEV compaction is tried first so the same model can still serve the request |
| **📦 Context Management** | Compresses older history when conversations exceed token limits, preserving recent turns and system prompts |

### JEV Mode (Smart Context Compaction)

When a request outgrows the best model's context window, JEV Mode replaces the old lossy digest with model judged verbatim compaction:

| Capability | Behavior |
|---|---|
| **🔎 Verbatim, not summaries** | The healthiest configured model (the "judge") is asked which old tool calls and results are still needed. Everything kept stays verbatim. User and assistant text is never rewritten. |
| **🩺 Automatic model testing** | Every probe doubles as a live health test. Unresponsive, erroring, or rate limited models are reported to the circuit breaker and the next best candidate takes over automatically. |
| **🪆 Judge failover** | Up to 2 judge candidates are tried per compaction. If every judge fails, the router falls back to the local compression, never to a broken request. |
| **🧠 Smart token utilization** | Tool call args and results now count toward token estimates (they were previously treated as free), and context is compacted to fit the best task matched model instead of degrading to a bigger window but worse fit one. |
| **📌 Pinning** | The first message and the most recent turns are always pinned and never modified. |

JEV Mode is ON by default and only activates when a request actually outgrows the target model's window (probes are otherwise never spent). Toggle it in the dashboard next to the Auto Rotation switch. The card also shows the last compaction stats (tokens saved, calls dropped, judge used, duration).

### Manual Overrides

Force a specific model or capability directly in your prompt:

```
#model:<model-name>       → e.g. #model:deepseek-chat
#:code                    → force routing to coding models
#:vision                  → force routing to vision models
```

---

## 📊 Dashboard

Jev AnityG-Mode includes a built in dashboard (served by the proxy) for monitoring routing decisions, model health, and request history. Access it via the tray icon or by navigating to the proxy's dashboard endpoint.

The dashboard provides:

1. **Auto Rotation / Smart Router** master switch
2. **JEV Mode** switch with last compaction stats (tokens saved, calls dropped, judge used)
3. **⚡ Test All** button that pings every configured model and marks the ones that respond. Unresponsive models are avoided by the smart router

---

## 🛠️ Manual Build & Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Deploy (classic Antigravity)
powershell -ExecutionPolicy Bypass -File deploy.ps1

# Deploy (Antigravity IDE 2.5+)
powershell -ExecutionPolicy Bypass -File deploy-ide.ps1
```

### Available Scripts

| Script | Description |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run dev` | Watch mode, recompiles on save |
| `npm test` | Run tests with Vitest |
| `npm run test:watch` | Run tests in watch mode |
| `npm run lint` | Lint source with ESLint |
| `npm run lint:fix` | Auto fix lint issues |
| `npm run format` | Format source with Prettier |
| `npm run format:check` | Check formatting without writing |

---

## ⚙️ How It Works

Antigravity's language server connects to Google API endpoints. The mod redirects this traffic to a lightweight local proxy (`proxy.ts`, running on port 50999 or the next available port).

The proxy:

1. **Injects** your configured models into the IDE's model list.
2. **Intercepts** generation calls and translates Gemini API request formats to OpenAI, Anthropic, or Ollama formats.
3. **Streams** responses back to the IDE in the format it expects.

When **Auto** is enabled, `autoRouter.ts` parses the incoming payload, scores your configured models based on requirements (vision, context, coding), and routes the request, falling back to the next best model on failure.

---

## 📂 Project Structure

```
Jev-AnityG-Mode/
├── src/
│   ├── main.ts                  # Electron main process entry
│   ├── preload.ts               # Preload script (bridge between main & renderer)
│   ├── proxy.ts                 # Local proxy server: request interception & streaming
│   ├── proxy/
│   │   ├── autoRouter.ts        # Smart classification, scoring & fallback routing
│   │   ├── dashboard.ts         # Built in monitoring dashboard
│   │   ├── modelUtils.ts        # Model capability helpers
│   │   ├── registry.ts          # Model registry & configuration loader
│   │   ├── shared.ts            # Shared proxy types & utilities
│   │   ├── smartHealth.ts       # Provider health tracking
│   │   └── translators/
│   │       ├── anthropic.ts     # Anthropic Claude format adapter
│   │       ├── google.ts        # Google Gemini format adapter
│   │       ├── ollama.ts        # Ollama format adapter
│   │       ├── openai.ts        # OpenAI format adapter
│   │       └── utils.ts         # Shared translator utilities
│   ├── ideInstall/              # IDE setup & configuration logic
│   ├── services/                # Background services
│   ├── cryptoStore.ts           # Encrypted credential storage
│   ├── ipcHandlers.ts           # Electron IPC handlers
│   ├── languageServer.ts        # Language server integration
│   ├── types.d.ts               # TypeScript type definitions
│   ├── utils.ts                 # General utilities
│   ├── __tests__/               # Test suite
│   └── __mocks__/               # Test mocks
├── install.bat                  # Windows installer
├── uninstall.bat                # Windows uninstaller
├── deploy.ps1                   # Deploy script (classic Antigravity)
├── deploy-ide.ps1               # Deploy script (Antigravity IDE 2.5+)
├── proxy-standalone.js          # Standalone proxy runner (no Electron)
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

---

## 🔒 Security & Privacy

1. **Encrypted keys**. API keys are encrypted at rest using Electron's `safeStorage` (Windows DPAPI / macOS Keychain).
2. **Local only proxy**. All routing runs entirely on `localhost`. Conversations only travel between your machine and whichever provider API you configure.
3. **SSL verification**. Enabled by default. Only set `allowUnauthorized: true` for local self signed dev endpoints.

---

## 🤝 Contributing

Contributions are welcome. To get started:

1. Fork the repository.
2. Create a feature branch: `git checkout -b feature/my-feature`.
3. Make your changes and ensure tests pass: `npm test`.
4. Run the linter: `npm run lint`.
5. Submit a pull request.

Please follow the existing code style (enforced by ESLint + Prettier).
#
