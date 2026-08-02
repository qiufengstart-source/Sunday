# Generation Flow Light Align Implementation Plan

> **For agentic workers:** Implement task by task. Spec: `docs/superpowers/specs/2026-08-02-generation-flow-light-align-design.md`.

**Goal:** Lightly align V4.0 UX to the swimlane flowchart without a separate text LLM.

**Files:**
- Modify: `generation-helpers.mjs`, `test/generation-helpers.test.mjs`, `app.js`, `styles.css`

## Task 1: Same-request helper + tests

Add `isSameGenerateRequest` / `isSameGenerationPackage` in `generation-helpers.mjs` with unit tests.

## Task 2: Wire send/regenerate UX in app.js

- Change detection confirm
- Prompt preview system message + render `<details>`
- Count-adjustment system notice
- Keep `queued` during fetch; improve 429 copy
- First-success soft guide

## Task 3: CSS for prompt preview + verify

Minimal `.prompt-preview` styles; run `node --test test/generation-helpers.test.mjs`.
