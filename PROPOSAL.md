# Proposal: Boku Payouts API — Public Design Decision-Record Site

## Executive Summary

For Boku's Senior Backend Engineer take-home, the Payouts API design currently exists as a set of local markdown docs and a single ephemeral HTML artifact. This proposal packages that work into a small, deployed web application — a doc viewer, following the pattern already proven in `architecture-practice` — so the Hiring Manager walkthrough has one clean, navigable, public link instead of a bundle of files. Expected outcome: a live Vercel-hosted site presenting the requirement analysis, architecture decisions, design principles, and tech stack, in a structure suited to being walked through live, plus a durable public record of the work.

## Problem Statement

- **Current state**: the design work (`payouts_api_design.md`, `dash_vs_boku_comparison.md`, and a one-off HTML artifact) lives across a private local folder and an ephemeral Claude Artifact link with no independent hosting.
- **Impact**: no single, permanent, shareable URL to hand the Hiring Manager or reference live during the walkthrough. Content is also split across formats — markdown vs. one static HTML page — with no consistent navigation between them.
- No performance/cost metrics apply here — this is a presentation and communication problem, not a system one.

## Proposed Solution

- Stand up a small static React + Vite application, `boku-payouts-design`, following the file-explorer + markdown-viewer pattern already built and proven in `architecture-practice` (`arch-doc-viewer`).
- Port the visual language already designed for this project (Superclarendon/Seravek type pairing, ledger-green palette, ADR-style decision cards) into the viewer's stylesheet, rather than restarting the visual design.
- Deploy publicly to Vercel, no authentication — this is meant to be shown, not gated.

**Why this approach**: reusing a working pattern instead of inventing a new one minimizes build risk and time spent on plumbing — which matters, because the deliverable actually being evaluated is the design reasoning, not the web app itself.

**Assumption**: content edits to the markdown docs will continue after this scaffold lands. This proposal covers the shell and structure, not final copy.

## Alternatives Considered

1. **Keep using the Claude Artifact link as-is.** Rejected — an artifact isn't a durable, independently-owned URL, and doesn't sit alongside the rest of the public portfolio (`thanhnguyen.dev`, `aiops.thanhnguyen.dev`).
2. **Static HTML export only, no React/Vite.** Rejected — loses the file-explorer / multi-doc navigation the reference project already solved, and would mean re-solving markdown rendering by hand for every future doc.
3. **Next.js instead of Vite.** Rejected for this scope — no server rendering, data fetching, or routing complexity that would justify it. Vite is simpler and matches the reference project exactly.

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Scope creep — polishing the web app instead of the design reasoning that's actually being scored | Med | High | Time-box the scaffold to a single pass; content review stays the priority ahead of the HM round |
| Public deploy exposes interview-prep specifics (compensation, scheduling, internal notes) | Med | Med | Keep private prep files (`analysis.md`, `interview_prep_plan.md`) out of `public/docs/` — only publish the design-reasoning docs |
| Vercel deploy config drifts from the working `architecture-practice` reference | Low | Low | Copy the `vercel.json` rewrite pattern directly rather than reinventing it |

## Implementation Plan

1. Scaffold repo: `package.json`, `vite.config.js`, `index.html`, `src/` (`App`, components, services, styles) — mirrored from `architecture-practice`.
2. Add `public/docs/index.json` registry with the Payouts API docs.
3. Port the decision-record visual styling into `src/styles/main.css`.
4. Omit `AuthGuard` entirely — public by design, no login gate.
5. Add `vercel.json` with the same rewrite pattern as the reference project.
6. Verify locally with `npm run dev`.
7. User reviews and updates the markdown content.
8. Deploy to Vercel.

## Rollback Plan

Static site, no backend or persistence — rollback is a Vercel redeploy of the previous commit, or removing the Vercel project entirely. No destructive or data-migration step exists at any stage.

## Success Metrics

- All registered docs render correctly, on both desktop and mobile.
- File explorer + markdown viewer navigation works with no console errors.
- Deployed Vercel URL matches local `npm run build && npm run preview` output.
- Visual styling reads consistently with the original decision-record artifact (same palette and type pairing).

## Open Questions

- Should `dash_vs_boku_comparison.md` be published publicly, or is it specific enough to the WU/DASH narrative that it should stay out of the public site?
- Any preference for a custom Vercel domain, or is the default `*.vercel.app` fine?
- Should this repo stay scoped to the Payouts API design only, or fold in future take-home tasks if the Boku process continues?
