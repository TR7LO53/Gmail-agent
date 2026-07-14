# Stage 1 — Implementation Guide (MVP: read-only Gmail tools + OAuth)

This document explains **exactly how Stage 1 gets built and verified**. It is split into three parts:

- **Part A — My part (the implementation).** What I build, in plain language, step by step.
- **Part B — Your part (data + external services).** The things only you can do (Google Cloud, consent, secrets).
- **Part C — Testing procedure.** Unit, integration, and end-to-end (E2E) tests, with concrete cases and commands.

**Goal of Stage 1:** prove the foundation works — log into Gmail read-only, and expose three tools
(`gmail_search`, `gmail_read`, `gmail_list_labels`) that return a clean, model-friendly response.
No AI agent, no database, no web UI yet — those come in Stages 2–5.

**Definition of done:** you can run a command (or ask Claude Code in VSC) to search your inbox, read a
thread, and list labels, and each call returns a structured JSON "envelope" with helpful hints — and
attachments come back as **links, never base64**.

---

## Part A — My part (the implementation)

I build the code as small, typed TypeScript functions. Each piece is independent and testable. Here is
the build order and what each step does, in simple terms.

### Step 1 — Set up the empty project
- Create `package.json`, install libraries, add a `tsconfig.json`, and a `.gitignore` that hides secrets.
- Libraries: `googleapis` (talks to Gmail), `@google-cloud/local-auth` (handles the login popup),
  `zod` (describes/validates tool inputs), `@modelcontextprotocol/sdk` (lets Claude Code call the tools).
  Dev tools: `typescript`, `tsx` (runs TS directly), `vitest` (tests).
- Add npm shortcuts: `npm run auth` (log in once), `npm run try` (run a tool from the terminal),
  `npm run mcp` (start the MCP server), `npm test` (run tests).
- **Result:** an empty but runnable project skeleton.

### Step 2 — Define the shared "response envelope"
- Every tool returns the **same shape**, so the future AI agent always knows what to expect.
- The shape (from course lesson S03E04):
  - `success` — did it work?
  - `data` — the actual result.
  - `next_action` — a hint about what to do next (e.g. "use gmail_read with this id").
  - `recovery` — what to do if something went wrong or there were no results.
  - `diagnostics` — behind-the-scenes info (the query that ran, how many results, limits hit).
- I add two tiny helpers, `ok(...)` and `fail(...)`, so every tool builds this shape consistently.
- **Result:** one consistent "language" for all tools.

### Step 3 — Log into Gmail (OAuth) and create the Gmail client
- `auth.ts` does the login dance:
  1. Look for a saved login token (`data/token.json`). If found, reuse it.
  2. If not found, open your browser, you approve **read-only** access, and the token is saved.
  3. Tokens refresh automatically afterward, so you only approve once.
- `client.ts` turns that login into a ready-to-use Gmail client object and caches it.
- If the token is missing or expired, the tools don't crash — they return a friendly
  `recovery` message: "Authorization expired, run `npm run auth` again."
- **Result:** authenticated, read-only access to your mailbox.

### Step 4 — Build the search-query helper
- Gmail search uses a text syntax like `from:dhl.com is:unread after:2026/06/01`.
- `query.ts` is one small, pure function that turns clean inputs (from, to, subject, dates, hasAttachment,
  isUnread, label) into that text. Keeping it separate makes it easy to test on its own.
- It fixes problems the course called out: supports **multiple recipients**, uses clear date names
  (`after`/`before` instead of a vague "date"), and supports paging.
- **Result:** reliable, testable translation from structured input to Gmail's search language.

### Step 5 — Build `gmail_search`
- Input: any mix of `from`, `to[]`, `subject`, `query` (free text), `label`, `after`, `before`,
  `hasAttachment`, `isUnread`, `maxResults` (default 25), `pageToken` (for the next page).
- How it works: build the query → ask Gmail for matching message ids → for each id, fetch just the
  headers + snippet (cheap) → assemble a tidy list.
- Each result row: `id`, `threadId`, `from`, `to`, `subject`, `date`, `snippet`, `labels`,
  `hasAttachment`, `isUnread`.
- Hints: `next_action` tells the agent to call `gmail_read` for full content; if nothing matched,
  `recovery` suggests loosening the filters; `diagnostics` shows the exact query and counts.
- **Result:** the core tool — proves real data flows out of your inbox in a clean shape.

### Step 6 — Build `gmail_read`
- Input: `id` (can be a single message **or** a whole thread — the tool figures out which, so the
  agent never has to guess) and `detail` (`summary` or `full`).
- How it works: it always returns the **whole conversation thread** (because tracking a parcel means
  following a thread). It decodes the email body to clean text (prefers plain text; strips HTML if needed).
- **Attachments are returned as references, never as base64.** Each attachment shows `filename`,
  `mimeType`, `sizeBytes`, and a `ref` link placeholder (the Stage 4 web UI will serve the real download).
  This is a hard rule from the course: inlining base64 "kills" the model's context.
- **Result:** readable thread content and safe attachment handling.

### Step 7 — Build `gmail_list_labels`
- Input: none. It lists your Gmail labels (`id`, `name`, `type`).
- Used once at startup so the agent knows which labels exist (e.g. a "Shipping" label you made).
- **Result:** label context for smarter searches later.

### Step 8 — Build the CLI test harness
- `cli.ts` lets you run any tool straight from the terminal and see the raw JSON envelope.
- Commands: `npm run auth`, `npm run try -- labels`, `npm run try -- search --from dhl.com --unread`,
  `npm run try -- read --id <id> --detail full`.
- **Result:** fast manual testing while building — no AI needed.

### Step 9 — Wrap the same tools as an MCP server (for Claude Code in VSC)
- `mcp/server.ts` exposes the **same** functions to Claude Code as `gmail__search`, `gmail__read`,
  `gmail__list_labels` (double underscore avoids name clashes, per the course).
- A small `.mcp.json` file registers the server, so inside VSC you can just say
  *"find unread DHL emails"* and Claude Code calls the tool.
- **Result:** two ways to use the exact same code — terminal and Claude Code chat.

### A design note that makes testing easy
Each tool function accepts its Gmail client as an injectable dependency (defaulting to the real one).
That means tests can pass a **fake** Gmail client and check behavior without touching the network.

---

## Part B — Your part (data + external services)

These are the steps only you can do, because they involve your Google account and secrets. Do them once.
I cannot create Google credentials for you. Estimated time: ~15 minutes.

### B1 — Install Node.js
- Install **Node.js 20 or newer** from [nodejs.org](https://nodejs.org/). Verify in a terminal: `node -v`.

### B2 — Create a Google Cloud project and turn on the Gmail API
1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project (or pick an existing one) — top-left project picker → **New Project**.
3. Open **APIs & Services → Library**, search **"Gmail API"**, open it, click **Enable**.

### B3 — Configure the consent screen (who is allowed to log in)
1. **APIs & Services → OAuth consent screen.**
2. User type: **External**. Fill the basics (app name e.g. "Gmail Agent", your email as support contact).
3. Leave it in **Testing** mode (no Google verification needed for personal use).
4. Under **Test users**, add **seb.mihaljev@gmail.com**. Only listed test users can log in.

### B4 — Create the OAuth credentials and download them
1. **APIs & Services → Credentials → Create credentials → OAuth client ID.**
2. Application type: **Desktop app**. Name it anything.
3. Click **Download JSON**. Rename the file to **`credentials.json`** and place it in the **project root**
   (the same folder as `package.json`).
4. **Keep this file private** — it is a secret. It is already in `.gitignore`.

> Scope note: the app only ever requests **read-only** access
> (`https://www.googleapis.com/auth/gmail.readonly`). It cannot send, edit, or delete email — there are
> simply no tools for that.

### B5 — Approve access once
- After I deliver the code, run `npm install`, then **`npm run auth`**.
- Your browser opens, Google asks you to approve read-only access — approve it.
- A `data/token.json` file is saved. You won't need to repeat this unless you revoke access.

### B6 — Give me test inputs
So I can write meaningful tests and demo, tell me (or just keep handy):
- One **real sender** you actually receive parcel/courier mail from (e.g. `noreply@dhl.com`,
  `info@inpost.pl`, an Allegro/Amazon address).
- Optionally, whether you use any **Gmail label** for shipping mail.

### B7 — (For the Claude Code path) approve the MCP server in VSC
- Open the project folder in VSC with Claude Code.
- When prompted, **approve** the `gmail` MCP server (it's defined in `.mcp.json`).
- Then test by asking, e.g., *"use gmail__search to find unread emails from DHL."*

### What stays secret (never commit / never share)
`credentials.json`, `data/token.json`, and the `.env` file. All are gitignored by default.

---

## Part C — Testing procedure

Test framework: **Vitest** (TypeScript-native, fast, well documented). Three layers, from cheapest to most real.

```
tests/
├── unit/          ← pure logic, no network, no Gmail
├── integration/   ← tools against a FAKE Gmail client (no network)
└── e2e/           ← real test Gmail account (guarded; runs only when a token exists)
```

Run commands:
- `npm test` — unit + integration (fast, safe, no account needed).
- `npm run test:e2e` — the real-mailbox checks (only after `npm run auth`).

### C1 — Unit tests (pure functions, no Gmail involved)
These are fast and deterministic. They protect the trickiest logic.

| Area | What we assert |
| :-- | :-- |
| `buildQuery` | `{from:'dhl.com', isUnread:true}` → `from:dhl.com is:unread`; multiple `to[]` produce repeated `to:`; `after`/`before` format as `YYYY/MM/DD`; empty input → empty/neutral query. |
| Envelope helpers | `ok(data)` sets `success:true`; `fail(msg)` sets `success:false` + `recovery`; optional fields appear only when provided. |
| Body decoding | base64url payload decodes to correct UTF-8 text; prefers `text/plain` part; falls back to stripped `text/html`; handles nested multipart parts. |
| Attachment mapping | an attachment part becomes `{filename, mimeType, sizeBytes, attachmentId, ref}` and **never contains base64 data** (explicit assertion that no field holds the raw bytes). |
| Header mapping | `From/To/Subject/Date` headers map to the right fields; `hasAttachment` is true only when a part has a filename; `isUnread` reflects the `UNREAD` label. |

### C2 — Integration tests (tools + a fake Gmail client, still no network)
We inject a **mock** Gmail client (canned responses), so we test each tool's full behavior offline.

| Tool | Scenarios |
| :-- | :-- |
| `gmail_search` | Happy path: mock `messages.list` + `messages.get` → envelope has tidy `messages[]`, `next_action`, `diagnostics.query`. **Empty results:** returns `success:true`, empty list, and a `recovery` hint. **Pagination:** a `nextPageToken` from the mock is surfaced. |
| `gmail_read` | Given a **message id**, it resolves to the thread and returns full thread context. Given a **thread id**, it loads the thread directly. `detail:'summary'` vs `'full'` return the expected amount of body. Attachments come back as refs. |
| `gmail_list_labels` | Maps mock labels to `{id, name, type}` and includes a `next_action` pointing to `gmail_search`. |
| Error handling | A simulated auth failure (mock throws) → tool returns `success:false` with a clear `recovery` ("run `npm run auth`"), not an unhandled crash. A simulated bad id → `recovery` explaining the id wasn't found. |

Why this matters: these tests prove the tools behave correctly and produce the right hints **without
needing your real inbox**, so they run in seconds and in CI.

### C3 — End-to-end tests (real test Gmail account)
These run against your actual (read-only) mailbox and only execute when `data/token.json` exists — they
**skip automatically** otherwise, so they never break the normal test run.

E2E checklist (also doubles as the manual acceptance walkthrough):
1. **Auth:** `npm run auth` completes and creates `data/token.json`.
2. **Labels:** `npm run try -- labels` prints your real labels → proves login + API access.
3. **Search:** `npm run try -- search --from "<your test sender>" --after 2026/06/01 --max 10`
   returns real messages with correct `hasAttachment` / `isUnread` / `labels`, plus `next_action` and `diagnostics`.
4. **Read:** take an `id` from step 3 → `npm run try -- read --id <id> --detail full` shows the full thread
   text and attachment **references** — confirm there is **no base64 blob** anywhere in the output.
5. **Empty result:** a deliberately impossible search returns the friendly `recovery` hint.
6. **Auth recovery:** temporarily rename `data/token.json` and run any tool → it returns the
   "re-authorize" `recovery` message instead of crashing. (Rename it back afterward.)
7. **MCP / Claude Code path:** open the project in VSC, approve the `gmail` server, and ask Claude Code
   *"use gmail__search to find unread emails from DHL"* → it calls the tool and shows the structured result.

### C4 — What "passing" means for Stage 1
- All unit + integration tests green (`npm test`).
- The 7-step E2E checklist passes on your real mailbox.
- Confirmed: attachments are references, never base64; tools degrade gracefully with helpful `recovery`
  messages; the same code works from both the terminal and Claude Code.

---

## Quick reference — who does what

| Step | You (Part B) | Me (Part A) |
| :-- | :-- | :-- |
| Google Cloud project + Gmail API on | ✅ | |
| OAuth consent screen + test user | ✅ | |
| Download `credentials.json` to project root | ✅ | |
| Provide a real test sender | ✅ | |
| `npm install`, write all code & tests | | ✅ |
| `npm run auth` (one-time browser approval) | ✅ | |
| Approve the MCP server in VSC | ✅ | |
| Run/verify tests, deliver working tools | | ✅ |
