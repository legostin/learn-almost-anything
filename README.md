# Learn (Almost) Anything

> A local desktop app that turns a topic into a personalized course, then helps you study it with lessons, images, interactives, tests, homework review, and lecture audio.

[![Release](https://img.shields.io/github/v/release/legostin/learn-almost-anything?include_prereleases&label=release)](https://github.com/legostin/learn-almost-anything/releases)
[![Build](https://img.shields.io/github/actions/workflow/status/legostin/learn-almost-anything/release.yml?label=build)](https://github.com/legostin/learn-almost-anything/actions/workflows/release.yml)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey)](https://github.com/legostin/learn-almost-anything/releases)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-24C8DB)](https://tauri.app)
[![Agents](https://img.shields.io/badge/agents-Claude%20Code%20%7C%20Codex-7c3aed)](#agents-and-billing)

<p align="center"><img src="screens/2.png" alt="A generated lesson with sourced images and a multilingual course sidebar" width="900"></p>

## What It Does

Learn (Almost) Anything is not a hosted course platform. It is a local app that uses agent CLIs already installed on your machine:

- **Claude Code** through your Claude Pro / Max account.
- **Codex CLI** through your ChatGPT / Codex account.

You choose a topic, language, format, and agent. The app asks clarifying questions, drafts a course plan, generates lesson material, and keeps the resulting course on your machine.

## Course Generation

- **Formats:** full academic course, compact mini-course, or podcast-style series.
- **Languages:** course language is separate from app UI language. One library can contain English, Russian, Chinese, or other-language courses side by side, with language filters on the dashboard.
- **Lessons:** articles, diagrams, sourced images, galleries, and sandboxed interactive widgets.
- **Study flow:** comprehension tests, practical assignments, iterative agent review, and retry-until-passed progress.
- **Audio:** built-in OS TTS is free; optional Gemini TTS can produce higher-quality lecture audio.
- **Catalog:** browse public `.laacourse` packages, install them locally, publish your own courses with an upload token, and pull catalog updates later.
- **Sharing:** open a local course to someone else through ngrok when you explicitly start sharing.

The app writes the selected course language into prompts for wizard questions, plans, lesson text, tests, assignments, and review. Mixed-language libraries are expected, not an edge case.

## Agents And Billing

The app itself is free and does not run a paid backend for generation. Costs and limits come from the external accounts you connect.

| Feature | What pays for it | Notes |
|---|---|---|
| Course planning, lesson writing, tests, homework review | Claude Code or Codex CLI | Uses your local authenticated CLI. Provider usage limits still apply. |
| Claude Code | Claude Pro / Max, or Claude API credits if you opt into API usage | Claude Code usage shares limits with Claude. If `ANTHROPIC_API_KEY` or API-credit flow is active, usage can be billed separately at API rates. |
| Codex CLI | ChatGPT / Codex plan credits and limits, or OpenAI API key usage | Codex has plan limits and token/credit accounting. Extra credits or API-key usage can incur separate charges. |
| Web and image search via Brave | Your Brave Search API plan/quota | Optional. Used for grounding and image/source discovery when configured. |
| Custom generated illustrations | Gemini API | Optional. Image-generation models may require paid Gemini API usage. |
| Premium lecture audio | Gemini API | Optional. Audio is generated in chunks and cached on disk so the same chunk is not paid for repeatedly. |
| Built-in lecture audio | Operating system TTS | Free, local OS voice quality. |
| Catalog browsing/downloading | None from the app | Publishing needs only a catalog upload token. |

Pricing changes often. Check the current provider pages before relying on a budget:

- [Claude Code with Pro / Max](https://support.claude.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan)
- [Codex pricing](https://chatgpt.com/codex/pricing/)
- [Codex rate card](https://help.openai.com/en/articles/20001106-codex-rate-card)
- [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [Brave Search API](https://brave.com/search/api/)

For predictable spend, start with mini-courses, use the built-in OS TTS, leave Gemini disabled, and watch `/status` or the provider dashboards for the selected agent.

## Install

Download the latest build from [Releases](https://github.com/legostin/learn-almost-anything/releases).

- **macOS:** choose `..._aarch64.dmg` for Apple Silicon or `..._x64.dmg` for Intel. Builds are signed with Developer ID and notarized by Apple.
- **Windows:** choose the x64 `.msi` or `.exe`. Windows builds are currently unsigned, so SmartScreen may warn.

The UI starts in English. Russian UI is available in Settings. Course content can be generated in the course language you select.

## Requirements

1. **Node.js 20+** — the sidecar runs the agent SDKs through Node.
2. **At least one local agent CLI:**

   | Agent | Typical account | Install |
   |---|---|---|
   | Claude Code CLI | Claude Pro / Max | `npm i -g @anthropic-ai/claude-code` then `claude login` |
   | Codex CLI | ChatGPT / Codex plan | `npm i -g @openai/codex` then `codex login` |

You can install both and choose the backend per course. The desktop app uses the CLI executable already installed on your machine instead of bundling a private copy. After installing or moving a CLI, restart the app so PATH detection refreshes.

## Updates

Starting with `v0.1.2`, installed desktop builds can check GitHub Releases from Settings, download a signed updater bundle, install it, and restart. Update signing uses a Tauri updater key stored in GitHub Actions secrets, and the app verifies the update before installing it.

## Latest Release

`v0.1.4` stops production agent checks from launching `claude --version` or `codex --version`, so macOS Gatekeeper prompts do not appear just from opening the app or Settings. The selected CLI is launched only when generation needs it.

`v0.1.3` fixed production agent discovery and stopped bundling native agent CLI binaries into the app.

`v0.1.2` added signed in-app updates.

`v0.1.1` added the public catalog, course format selection, richer lesson visuals, and macOS signing/notarization fixes.

## Local Data And Privacy

- Course data is stored locally in the app data directory.
- The app does not host your generated lessons on a Learn server.
- Agent providers receive the prompts and course context needed for generation.
- Optional Gemini and Brave integrations receive only the requests needed for the feature you enabled.
- Public catalog publishing and ngrok sharing happen only when you explicitly start those actions.

## Develop

```bash
git clone https://github.com/legostin/learn-almost-anything.git
cd learn-almost-anything

pnpm install
pnpm --dir sidecar install

pnpm tauri dev
```

Requires Rust stable, pnpm, and Node 20+.

For local browser/share testing, keep the frontend build current:

```bash
pnpm build:watch
```

## Build Locally

```bash
pnpm tauri build
```

Artifacts are written under `src-tauri/target/release/bundle/`. Before bundling, `scripts/copy-sidecar.mjs` stages the Node sidecar into `src-tauri/sidecar/` and prunes bundled native agent CLI binaries so production builds use the user's installed CLIs.

For Developer ID macOS builds, provide the Apple signing and notarization environment expected by `.github/workflows/release.yml`.

## Catalog Server

The optional catalog service lives in `catalog-server/`:

```bash
cd catalog-server
npm start
```

It serves catalog metadata and `.laacourse` downloads. Set `CATALOG_UPLOAD_TOKEN` to allow publishing. `PORT`, `HOST`, `PUBLIC_ORIGIN`, and `CATALOG_DATA_DIR` are configurable.

## Architecture

- **Tauri 2** — desktop shell, windows, IPC, updater.
- **React 19 + TypeScript + Vite** — frontend.
- **Node sidecar** — calls `@anthropic-ai/claude-agent-sdk` and `@openai/codex-sdk`.
- **SQLite + files** — local course index and generated content.
- **Playwright-core + system Chrome** — visual checks for interactive widgets.
- **MCP servers** — bundled reference/search helpers for controlled agent tools.
- **Catalog server** — small Node service for public course packages.

## License

Not set. Source is open for reading and personal use; use at your own risk.
