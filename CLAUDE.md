# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Boku Payouts API — Design Decision Record** — a static-only web application for viewing the Payouts API design work prepared for Boku's Senior Backend Engineer take-home. Public, no authentication — this is meant to be linked and walked through live in the Hiring Manager interview, not gated.

See [`PROPOSAL.md`](./PROPOSAL.md) for the full rationale, alternatives considered, and risks.

## Tech Stack

- **Frontend**: React 18 (Vite)
- **Markdown rendering**: marked.js (via `renderService`)
- **Hosting**: Vercel, static build, no backend

## Project Structure

```
/
├── index.html
├── package.json
├── vite.config.js
├── vercel.json
├── src/
│   ├── main.jsx
│   ├── App.jsx
│   ├── components/
│   │   ├── FileExplorer.jsx    # doc list/nav, driven by public/docs/index.json
│   │   ├── MarkdownViewer.jsx  # renders markdown via marked.js
│   │   └── ThemeProvider.jsx   # light/dark theme context
│   ├── services/
│   │   ├── fileService.js      # loadIndex, loadDocument
│   │   └── renderService.js    # renderMarkdown
│   └── styles/
│       └── main.css            # decision-record visual language: Superclarendon/Seravek pairing, ledger-green palette
└── public/
    └── docs/                   # markdown source, served at /docs/
        └── index.json          # document registry — source of truth for the file explorer
```

## Architecture Principles

**Reused pattern, not a new one** — this repo mirrors `architecture-practice`'s (`arch-doc-viewer`) file-explorer + markdown-viewer shape deliberately, to minimize build risk on a deliverable where the design reasoning is what's being evaluated, not the web app.

**`public/docs/index.json` is the document registry** — the file explorer is driven entirely by this file. Adding a document means registering it here with `id`, `title`, `type`, `path`, `tags`.

**No auth, by design** — unlike `architecture-practice`, this repo has no `AuthGuard`. The content is meant to be public and shareable.

**Static-only** — no backend, no persistence. All rendering happens in the browser at request time from the deployed `public/docs/` markdown.

**Public/private boundary** — only the design-reasoning docs (`payouts_api_design.md` and the like) belong in `public/docs/`. Interview-logistics or scheduling material stays in the private local prep folder (`JobOpportunity/Boku_2026/`) and is never copied into this repo.

## Development Milestones

1. **Milestone 1** — Repo scaffold: `CLAUDE.md`, `PROPOSAL.md`, `README.md`, `.gitignore` ✅ (this commit)
2. **Milestone 2** — App scaffold: Vite + React shell, `FileExplorer`, `MarkdownViewer`, ported visual styling, `vercel.json`
3. **Milestone 3** — Content: register and finalize the design docs in `public/docs/`
4. **Milestone 4** — Deploy to Vercel, verify public URL

## Key Constraints

- Static-only — no build-time secrets, no server-side logic
- No authentication — public by design
- Content lives in markdown under `public/docs/`; `index.json` is maintained by hand, no auto-indexing
