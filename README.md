# agentic-task-dispatcher

> 中文：多库任务的**确定性**编排控制器——契约检查、幂等写入、对账与默认 dry-run；语义判断留给人，机械路径可回放。

**Deterministic multi-database task dispatcher** for agentic workflows: contract checks, idempotent writes, reconciliation, and **dry-run by default**. No LLM calls in the control loop — semantic judgment stays with humans; mechanical paths stay replayable.

[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Tests](https://img.shields.io/badge/tests-vitest-orange)](#testing)

## Why this exists

High-token agent polling of a Notion-style task board is expensive and hard to audit. This controller replaces that loop with a **pure deterministic pipeline**:

1. Load config JSON + read `NOTION_API_KEY` from the process environment
2. Acquire a single-instance lock
3. Resume from a cursor
4. Query task candidates (DRAFT / waiting states)
5. Run pure-function **contract checks**
6. Write only what the **write allowlist** permits (idempotent, optimistic lock)
7. Verify writes
8. Run **reconciliation** assertions
9. Emit structured JSON logs

Semantic decisions (independent review outcomes, human acceptance, kill, model/provider choice) are **denylisted** — the controller never invents them.

## Features

| Capability | Behavior |
|---|---|
| Dry-run by default | Write path is gated by CLI `--execute` (not by config JSON); without it the run does not write |
| Contract checks A–E | Project–task relation, Run creation uniqueness, model/fallback events, gates, deliverable uniqueness |
| Idempotency | Stable keys + hashes; duplicate webhooks do not create duplicate records |
| Optimistic lock | Version mismatch stops overwrite and re-reads |
| Single-instance lock | File lock with TTL; second process exits `LOCKED` |
| Cursor resume | Tracks processed task URLs across runs |
| Reconciliation | Flags orphans, duplicate Run IDs, missing gates, baseline drift — suggests only, does not auto-fix business conclusions |
| Exit codes | `0` OK · `2` PARTIAL · `3` ERROR (deterministic/API) · `4` LOCKED |

## Quick start

```bash
# 1) Install
npm ci

# 2) Configure (never commit the real file)
cp config/config.example.json config/config.json
# edit config/config.json → your Notion data source IDs

# 3) Provide credentials via environment only (export in the same shell; .env is NOT auto-loaded)
export NOTION_API_KEY="ntn_..."   # do not hardcode

# 4) Dry-run first (default — no --execute)
npm run dry-run
# or
npm run dev -- --once

# 5) Only after you trust the dry-run log
npm run execute -- --once

# Reconciliation report mode
npm run reconcile
```

### Scripts

| Script | Purpose |
|---|---|
| `npm test` | Unit tests (contract checks — no network) |
| `npm run test:watch` | Watch mode for unit tests |
| `npm run lint` | `tsc --noEmit` |
| `npm run build` | Compile to `dist/` |
| `npm run dev` | Run TS entry via `tsx` (pass flags after `--`) |
| `npm run dry-run` | Control loop, no writes |
| `npm run execute` | Control loop with writes |
| `npm run once` | Single pass |
| `npm run reconcile` | Reconciliation findings |

## Configuration

- **`config/config.example.json`** — template with placeholder database IDs. The `dry_run` fields are retained for config-shape compatibility only; **write gating is controlled by the CLI** (`--execute`), not by these JSON fields.
- **`config/config.json`** — local only (gitignored). Copy from the example.
- **`NOTION_API_KEY`** — process environment only (e.g. `export` in your shell). Missing key → clear error; never logged.

Property names in `src/types.ts` mirror your Notion task/project/record schemas. Adjust them to match your workspace (see `schema/schema-snapshot.example.json` for a minimal illustration).

Status option values (`WAITING_FOR_WORKER_A`, `WAITING_FOR_WORKER_B`, `WAITING_FOR_PRIMARY`, …) and executor values (`Worker A`, `Worker B`, `Primary`) are **illustrative placeholders**. They are arbitrary names for your own execution lanes — rename them to whatever your board uses, and keep the option list in `src/contract.ts`, the transitions in `src/types.ts`, and your Notion select options in sync.

## Architecture

```
src/
├── controller.ts    # 9-step pipeline, CLI flags, lock + cursor
├── config.ts        # loads config/config.json
├── notion.ts        # Notion client wrapper (API key from env)
├── contract.ts      # pure contract checks (unit-tested)
├── state.ts         # transitions, routing, health/gate math
├── idempotency.ts   # hashes, Run idempotency keys, baseline hash
├── reconcile.ts     # reconciliation checks (orphan / drift / duplicate Run, …)
├── logger.ts        # structured JSON logs
└── types.ts         # shared types + exit codes
tests/
└── contract.test.ts # pure unit tests (no Notion network)
```

### Write allowlist vs denylist

**Can write (mechanical):** hashes, version bumps, health status, drift markers, mechanical gate results, idempotent Run/Gate/Model Event records.

**Must not write (semantic):** independent review results, manual acceptance, KILL decisions, model/provider selection, task → CLOSED, any human/AI judgment.

## Testing

```bash
npm test
```

`tests/contract.test.ts` exercises identifier fallbacks and contract batch rules with in-memory fixtures. No API key or network required.

## Safety notes

- Default is dry-run; use `--execute` deliberately.
- Do not commit `config/config.json` or `.env` (gitignored for safety; credentials are read from the process environment, not from `.env` auto-load).
- Reconciliation only **flags** issues — it does not rewrite business conclusions.
- This project automates mechanical bookkeeping only. It deliberately does not decide anything that a human owner or a formal business system owns — no approvals, no findings, no conclusions.

## License

[MIT](./LICENSE)
