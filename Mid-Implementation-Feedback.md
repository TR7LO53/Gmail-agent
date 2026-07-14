# Mid-Implementation Feedback — Gmail Parcel Agent
**Date:** 2026-06-30  
**Stages completed:** 1 (Gmail tools + OAuth) and 2 (Classifier + SQLite memory)  
**Next stage:** 3 — Heartbeat + Agent Tracker  
**Status:** 50/50 tests passing · 0 TypeScript errors · live classify command operational

---

## 1. Environment

| Item | Detail |
|---|---|
| OS | Windows 11 Home 10.0.26200 |
| Shell primary | PowerShell 5.1 (Windows PowerShell, not Core) |
| Node version | 23.x (verified — `node:sqlite` built-in is stable here) |
| Package manager | npm (with `strict-ssl=false` set globally — see §4) |
| IDE | VSCode with Claude Code extension |
| Working directory | `c:\Users\sebas\OneDrive\Pulpit\Tools\AI\Gmail agent\gmail-agent\` |
| Git | No git repo initialised yet |

### Critical npm config
`npm config set strict-ssl false` is set **globally** on this machine. Corporate proxy/cert chain causes SSL verification failures without it. Every new package install that fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` needs this setting — it is already applied, do not change it.

---

## 2. Project layout

```
gmail-agent/
├── src/
│   ├── gmail/
│   │   ├── auth.ts          OAuth 2.0 Desktop flow (scope: gmail.readonly only)
│   │   ├── client.ts        Authenticated gmail_v1 factory (cached singleton)
│   │   ├── query.ts         buildQuery() — structural fields → Gmail q string
│   │   └── parse.ts         Email body + attachment parsing helpers
│   ├── tools/
│   │   ├── types.ts         ToolResponse<T>, ok(), fail() — shared envelope
│   │   ├── errors.ts        Typed error classes (AuthError, etc.)
│   │   ├── gmail-search.ts  gmailSearch() — wraps users.messages.list
│   │   ├── gmail-read.ts    gmailRead() — reads full thread, returns body + attachment refs
│   │   └── gmail-labels.ts  gmailListLabels()
│   ├── mcp/
│   │   └── server.ts        MCP stdio server exposing the three Gmail tools
│   ├── llm/
│   │   └── provider.ts      LLMProvider interface + openaiProvider (OpenAI adapter)
│   ├── memory/
│   │   ├── db.ts            openDb() — node:sqlite via createRequire trick (see §4)
│   │   ├── parcels.ts       upsertParcel(), getParcel(), listActiveParcels(), listAllParcels()
│   │   └── decisions.ts     recordDecision(), listDecisions()
│   ├── agents/
│   │   └── classifier.ts    classifyEmail() + runClassifier() workflow
│   └── cli.ts               Entry point: auth/search/read/labels/classify/parcels/decisions
├── tests/
│   ├── helpers/fake-gmail.ts  Shared Gmail fake for integration tests
│   ├── unit/                  query, parse, types, parcels, decisions, classifier-schema
│   ├── integration/           gmail-search, gmail-read, gmail-labels, classifier (all with fakes)
│   └── e2e/                   gmail.e2e, classifier.e2e (auto-skip without real credentials)
├── data/                    GITIGNORED — token.json, gmail-agent.db
├── credentials.json         GITIGNORED — Google OAuth Desktop client
├── .env                     GITIGNORED — OPENAI_API_KEY, OPENAI_MODEL
├── .env.example             Committed — template only
├── .gitignore
├── .mcp.json                Registers MCP server for Claude Code / VSCode
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

---

## 3. Architecture decisions (locked — do not revisit)

### 3.1 Read-only Gmail — enforced by tool absence
The agent has NO `gmail_send`, `gmail_modify`, or `gmail_delete`. This is intentional and non-negotiable. The restriction is enforced by **the absence of the tools**, not by configuration. OAuth scope is `gmail.readonly`. Do not add write tools.

### 3.2 LLM provider: OpenAI (not Anthropic)
User explicitly chose OpenAI. The `LLMProvider` interface in `src/llm/provider.ts` is the **single seam** — you can swap providers by swapping that file. Do not import `openai` anywhere else. The model is configured via `.env`:
```
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1-nano    # default; change here to swap
```
`gpt-4.1-nano` is intentionally small and cheap. If classification quality is insufficient, change `OPENAI_MODEL` in `.env` — no code changes needed.

### 3.3 Workflow, not ReAct
The Classifier is **code-driven**: fixed sequence `gmail_search → gmail_read → LLM classify → upsertParcel/recordDecision`. The model makes one structured JSON call per email. It does NOT choose tools or decide the next step. This is deliberate (cheap, deterministic, testable). The ReAct loop is a possible Stage 5+ enhancement.

### 3.4 SQLite: node:sqlite built-in (not better-sqlite3)
`better-sqlite3` was abandoned — native compilation failures on Node 23 + SSL cert issues made it uninstallable. The project uses Node.js built-in `node:sqlite` (stable since Node 22.5). **The API is identical to better-sqlite3** (synchronous, prepared statements, `.run()/.get()/.all()`). DB file lives at `data/gmail-agent.db` (gitignored).

### 3.5 ToolResponse envelope on every function
Every tool returns `ToolResponse<T>` with `{ success, data?, next_action?, recovery?, diagnostics? }`. This is the contract between tools and any agent/caller. The Classifier's `runClassifier()` also returns this envelope. Future agents MUST respect this shape.

### 3.6 Dependency injection pattern
Every function that touches Gmail, LLM, or DB accepts a `deps` object: `{ gmail?, llm, db }`. This is what makes unit and integration tests work without network. Do not hardwire dependencies in function bodies.

### 3.7 `meta` table reserved for heartbeat
`decisions`, `parcels`, and `meta` tables exist in SQLite. The `meta` table (key/value) is empty but provisioned — intended for `last_checked` timestamp that the Stage 3 heartbeat will use to avoid re-scanning already-processed emails.

---

## 4. Known quirks and workarounds

### node:sqlite + Vitest/Vite bundling
Vite strips the `node:` prefix and tries to find an npm package called `sqlite`. This fails. The workaround in `src/memory/db.ts`:
```typescript
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";  // type-only, erased by esbuild
const _require = createRequire(import.meta.url);
// esbuild doesn't follow _require() statically, so Vite never sees node:sqlite
const { DatabaseSync } = _require("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };
```
Do NOT change this pattern. Do not try `server.deps.external`, `resolve.alias`, or `ssr.external` — they were all tried and failed. The `createRequire` trick is the only working solution.

### `strict-ssl=false` globally set
Already applied. If you see `UNABLE_TO_VERIFY_LEAF_SIGNATURE` on any npm install, this machine's SSL cert chain (likely corporate proxy) is the cause. Do not add `--legacy-peer-deps` or change registry — the global setting already handles it.

### Windows PowerShell 5.1
This is Windows PowerShell 5.1, not PowerShell Core. Pipeline operators `&&` and `||` do NOT work. Chain with `;` or `if ($?) { ... }`. The Bash tool is available for POSIX-style scripts.

### tsx for TypeScript execution
No build step. `tsx` (from devDependencies) executes TypeScript directly. All npm scripts use `tsx src/...`. No `dist/` directory exists or is needed.

---

## 5. Test coverage

| Suite | Count | What is tested |
|---|---|---|
| `tests/unit/query.test.ts` | 8 | `buildQuery()` field mapping |
| `tests/unit/parse.test.ts` | 6 | Body parsing, attachment detection |
| `tests/unit/types.test.ts` | 3 | `ok()`/`fail()` helpers |
| `tests/unit/parcels.test.ts` | 6 | `upsertParcel` idempotency, history append, `listActiveParcels` |
| `tests/unit/decisions.test.ts` | 4 | `recordDecision`, `listDecisions` ordering |
| `tests/unit/classifier-schema.test.ts` | 6 | Zod schema validation, enum rejection |
| `tests/integration/gmail-search.test.ts` | 8 | Gmail search with fake client |
| `tests/integration/gmail-read.test.ts` | 6 | Thread reading, attachment refs, body parsing |
| `tests/integration/gmail-labels.test.ts` | 4 | Label listing with fake |
| `tests/integration/classifier.test.ts` | 5 | `runClassifier` with fake LLM + fake Gmail + `:memory:` DB |
| `tests/e2e/gmail.e2e.test.ts` | 3 | Real Gmail (auto-skip without `data/token.json`) |
| `tests/e2e/classifier.e2e.test.ts` | 4 | Real OpenAI + Gmail (auto-skip without key/token) |
| **Total** | **63** | — |

Run commands:
- `npm test` — unit + integration (fast, free, no network)
- `npm run test:e2e` — e2e (requires `data/token.json` + `OPENAI_API_KEY`)
- `npm run typecheck` — zero TypeScript errors

---

## 6. CLI commands (Stage 2 state)

```bash
npm run auth                              # One-time OAuth flow
npm run try -- labels                     # List Gmail labels
npm run try -- search --from dhl.com --unread
npm run try -- read --id <id> --detail full
npm run classify -- --days 7 --max 20     # Main: scan + classify + save to DB
npm run try -- parcels                    # List active parcels from DB
npm run try -- parcels --all              # List all parcels (incl. delivered)
npm run try -- decisions --limit 50       # Last N classification decisions
npm run mcp                               # Start MCP server (for VSCode/Claude Code)
```

---

## 7. What Stage 3 needs to build

Stage 3 scope per the implementation plan: **Heartbeat + Agent Tracker**.

### 7.1 Heartbeat (scheduler)
A background loop that runs `runClassifier()` on a cadence (~5 min). It should:
- Read `meta.last_checked` from SQLite to avoid re-scanning emails already processed
- Write `meta.last_checked` after each run
- The `meta` table already exists — just write to it with `db.prepare("INSERT OR REPLACE INTO meta VALUES (?, ?)").run("last_checked", new Date().toISOString())`
- Use `setInterval` or a proper scheduler (e.g., `node-cron`)

### 7.2 Agent Tracker
A second agent that takes a parcel from the `parcels` table and performs **deeper** analysis — e.g., searching for more recent status emails on that specific tracking number's thread, or calling a carrier API. This agent uses the same `deps` injection pattern and same `ToolResponse` envelope.

### 7.3 The `meta` table `last_checked` key
The Classifier's `runClassifier()` currently has no awareness of what was already processed. Stage 3 should either:
- Filter emails by `after: meta.last_checked` in the `gmail_search` call, OR
- Check `decisions` table for already-seen `email_id` values before re-classifying

The `decisions` table records every `email_id` processed — this is the cleanest deduplication source.

### 7.4 Entry point
Stage 3 will likely add a new `heartbeat` command to `cli.ts` and a `src/agents/tracker.ts` file. Follow the same pattern as `src/agents/classifier.ts`.

---

## 8. Security constraints (must be preserved in all future stages)

- **No write tools to Gmail.** Never add `gmail_send`, `gmail_modify`, `gmail_delete`. Enforced by tool absence.
- **Secrets never in code.** `OPENAI_API_KEY` only in `.env`. Never in prompts, console.log, or source files.
- **Attachments always as refs.** `gmail_read` returns `{ filename, attachmentId, ref: "gmail://message/..." }` — never raw base64.
- **Gitignored files:** `credentials.json`, `data/token.json`, `.env`, `data/gmail-agent.db`. If git is initialised in Stage 3, verify `.gitignore` before first commit.
- **OAuth scope stays `gmail.readonly`.** Do not add scopes.

---

## 9. Dependencies (current state)

```json
{
  "dependencies": {
    "@google-cloud/local-auth": "^3.0.1",
    "@modelcontextprotocol/sdk": "^1.12.0",
    "dotenv": "^16.6.1",
    "googleapis": "^144.0.0",
    "openai": "^4.104.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "tsx": "^4.19.2",
    "typescript": "^5.7.0",
    "vitest": "^2.1.8"
  }
}
```

No native addons. No build toolchain. No database client library (node:sqlite is built-in).

---

## 10. User context and expectations

- User is learning AI agent development ("idę własną drogą, uczę się od podstaw" — building from scratch to learn, not to ship fast).
- Each stage is intentionally small. Do not add features beyond the stage scope.
- The user prefers **no unsolicited refactors** — fix bugs and implement what is asked, nothing more.
- Responses should be terse. No trailing summaries of what was just done.
- No emojis in code or responses (except the emoji already in `cli.ts` decision output — that was intentional).
- Tests are important. Every new module needs unit tests at minimum. Integration tests where fakes are straightforward.
- The user does not have a `.env` file yet — they need to create it manually before running any classify commands.
