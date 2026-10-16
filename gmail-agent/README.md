# Gmail Agent — Stage 1 (read-only tools + OAuth)

MVP foundation: log into Gmail **read-only** and expose three model-friendly tools —
`gmail_search`, `gmail_read`, `gmail_list_labels`. Usable two ways: a **CLI harness** and an **MCP
server** for Claude Code. No LLM, database or web UI yet (those are Stages 2–5).

> Full spec: see `../Stage-1-Implementation-Guide.md`.

## Setup (you, once)

1. **Node.js 20+** installed (`node -v`).
2. In [Google Cloud Console](https://console.cloud.google.com/): create a project → enable **Gmail API**.
3. **OAuth consent screen**: External, status *Testing*, add your Google account as a **Test user**.
4. **Credentials → OAuth client ID → Desktop app** → download JSON, save as `credentials.json` in this folder.
5. Install + log in:
   ```bash
   npm install
   npm run auth          # opens a browser; approve read-only access; saves data/token.json
   ```

Secrets (`credentials.json`, `data/token.json`, `.env`) are gitignored — never commit them.

## Export Presets to Android

Requires Node.js 22.5 or newer (the export opens SQLite with Node's `node:sqlite` `DatabaseSync` in read-only mode).

```bash
npm run export-presets
```

The command reads `data/gmail-agent.db` and writes `data/presets-backup.json`, with paths resolved from this `gmail-agent` package. It exports Presets only; Android receives empty slots and no food log entries. You can override paths with `npm run export-presets -- --db <path> --output <path>`. Relative option paths are also resolved from `gmail-agent`. The output is replaced after the complete backup has been validated.

**Manual check by a human after merge:** run `npm --prefix gmail-agent run export-presets`, copy the indicated JSON file to the phone, open **⚙ Ustawienia → Importuj kopię**, and select it. Confirm that the real Presets appear with **★ / Z Ggent** for newly added products, and that names, aliases, and macros are preserved with no new food log entries. Reopen the app and confirm they remain. For name conflicts, confirm the app reports that the existing product was skipped.

## Use it from the terminal

```bash
npm run try -- labels
npm run try -- search --from "noreply@dhl.com" --after 2026/06/01 --max 10
npm run try -- search --unread --attachment
npm run try -- read --id <messageOrThreadId> --detail full
```

Every command prints the JSON envelope (`success`, `data`, `next_action`, `recovery`, `diagnostics`).
Attachments are returned as `ref` links — **never base64**.

## Use it from Claude Code (MCP)

`.mcp.json` registers a `gmail` server exposing `gmail__search`, `gmail__read`, `gmail__list_labels`.
Open this folder in VSC with Claude Code, approve the server, then ask e.g.
*"use gmail__search to find unread emails from DHL."*

## Tests

```bash
npm test          # unit + integration (fast, no network/account)
npm run test:e2e  # real mailbox checks — only after `npm run auth`
npm run typecheck # tsc --noEmit
```

## News agent

The News agent runs as the last processing step of each heartbeat, including the `npm start` launcher. It searches across Gmail categories for active senders, reads up to 50,000 characters from each matching message, and scores real news against the interests stored in the database. Set `OPENAI_NEWS_MODEL` to choose its model; it defaults to `gpt-6-luna`. Failed reads or AI calls are retried on later heartbeats and stop after three failed attempts.

Set `E2E_TEST_SENDER` to a real sender to make the e2e search/read assertions meaningful:
```bash
E2E_TEST_SENDER="noreply@dhl.com" npm run test:e2e
```

## Layout

```
src/
  gmail/   auth.ts · client.ts · query.ts · parse.ts
  tools/   types.ts · errors.ts · gmail-search.ts · gmail-read.ts · gmail-labels.ts
  mcp/     server.ts        # MCP wrapper (gmail__search/read/list_labels)
  cli.ts                    # terminal harness
tests/
  unit/ · integration/ · e2e/ · helpers/
```
