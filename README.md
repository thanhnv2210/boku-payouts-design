# Boku Payouts API — Design Decision Record

A public, deployed presentation of the Payouts API design for Boku's Senior Backend Engineer take-home — requirement analysis, architecture decisions, design principles, and tech stack, built as a small static doc-viewer site.

See [`PROPOSAL.md`](./PROPOSAL.md) for the reasoning behind this repo's existence and structure.

## Tech Stack

- **Frontend**: React + Vite
- **Markdown rendering**: marked.js
- **Hosting**: Vercel (public, no authentication)

## Getting Started

**Prerequisites:** Node.js 18+

```bash
npm install
npm run dev
```

Open the local dev URL printed in the terminal.

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
│   ├── components/        # FileExplorer, MarkdownViewer, ThemeProvider
│   ├── services/          # fileService, renderService
│   └── styles/            # main.css — decision-record visual language
└── public/
    └── docs/               # markdown docs, served at /docs/
        └── index.json      # document registry — source of truth for the file explorer
```

## Document Registry

`public/docs/index.json` drives the file explorer. To add a document, register it there with `id`, `title`, `type`, `path`, and `tags`.

## Deployment

Deploys to Vercel as a static build. `vercel.json` handles SPA routing so deep links resolve correctly.

```bash
npm run build
vercel --prod
```

## Status

Scaffold in progress — content (`public/docs/`) will be added once the source markdown is finalized.
