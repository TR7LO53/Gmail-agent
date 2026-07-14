# Stage 2 — Implementation Guide (Classifier + memory for parcels)

This document explains **exactly how Stage 2 gets built and verified**. Like the Stage 1 guide, it is split
into three parts:

- **Part A — My part (the implementation).** What I build, in plain language, step by step.
- **Part B — Your part (data + external services).** The one thing only you can do (an OpenAI key).
- **Part C — Testing procedure.** Unit, integration, and end-to-end (E2E) tests, with concrete cases.

**Goal of Stage 2:** teach the agent to *understand* your mail. It scans your inbox, recognises emails about
courier shipments, pulls out the **tracking number, carrier, and status**, and **remembers** them in a small
local database — keeping a status history per parcel and a log of every decision it made (so the system can
learn from them later). No automatic schedule yet, no web page yet — those come in Stages 3 and 4.

**Definition of done:** you run one command and the agent reads recent mail, finds your parcels, and saves a
tidy list you can view — `tracking number → carrier → status` — plus a history of how each parcel's status
changed over time.

---

## What changed since Stage 1 (two decisions you made)

1. **The Classifier is "code-driven," not a free-roaming AI.** My code decides the steps (search the inbox →
   read each email → ask the model to classify it → save the result). The AI model is used only for the
   narrow job of **reading one email and returning structured facts**. This is cheaper, predictable, and easy
   to test. (A more autonomous "agent that decides its own steps" can come later, but it isn't needed here.)

2. **We use OpenAI models (not Anthropic), starting small and cheap.** The classifier defaults to
   **`gpt-4.1-nano`** — a tiny, low-cost model that's plenty for "is this a parcel email, and what's the
   tracking/carrier/status?". The model name lives in a settings file, so you can swap it in one line without
   touching code.

---

## Part A — My part (the implementation)

I build the code as small, typed, testable pieces — same style as Stage 1. Here's the build order and what
each step does in simple terms.

### Step 1 — Add the Stage 2 building blocks
- Add three libraries: **`openai`** (talks to the AI model), **`better-sqlite3`** (the local database — a
  single file, no server to run), and **`dotenv`** (loads your secret key from a `.env` file).
- Add a new shortcut: **`npm run classify`** (scan recent mail and update the parcel list), plus viewer
  shortcuts to print the saved parcels and the decision log.
- The `.gitignore` already hides secrets and the database file, so nothing private gets shared.
- **Result:** the project is ready for the "understanding" layer.

### Step 2 — One small, swappable connection to the AI ("the adapter")
- I add a single helper that sends an email's text to the model and gets back **structured facts in a fixed
  shape** (not free-form text the code would have to guess at). The model is *required* to answer in that
  shape.
- This helper is the **only** place that knows about OpenAI. It reads your key and the model name from the
  `.env` file (default model: `gpt-4.1-nano`). Changing models or providers later means editing this one file.
- If something goes wrong (missing key, rate limit, API hiccup), it reports a clear message instead of
  crashing.
- **Result:** one tidy, testable point of contact with the AI.

### Step 3 — The memory (a small local database)
- I create a single database file (`data/gmail-agent.db`) with two tables:
  - **`parcels`** — one row per tracking number: `carrier`, current `status`, `last_update`, the email thread
    it came from, and a **history** of every status it has had (so you can see "ordered → shipped → in
    transit → delivered").
  - **`decisions`** — a log: for each email, what the agent decided (tracked it / skipped it), its short
    reasoning, and the time. This is the "remember decisions to learn from later" piece you asked for.
- I add simple, safe save/read helpers (e.g. "add or update a parcel," "list parcels still on the way,"
  "record a decision"). A status only gets added to the history when it **actually changes**, so re-scanning
  the same mail doesn't create duplicates.
- **Result:** durable knowledge about your shipments, plus an audit trail.

### Step 4 — The Classifier (the heart of Stage 2)
- **What the model returns for each email:** is it parcel-related? and if so — tracking number, carrier
  (DHL, DPD, InPost, UPS, GLS, FedEx, Poczta Polska, Amazon, Allegro…), status
  (ordered / shipped / in transit / out for delivery / delivered), an optional estimated delivery, a
  confidence score, and a one-line reason.
- **How a run works, start to finish:**
  1. Use the Stage 1 search to gather candidate emails (e.g. the last few days, optionally only unread).
  2. For each one: read it, then ask the model to classify it.
  3. If it's a parcel with a tracking number → save/update the parcel **and** log the decision.
     Otherwise → just log "skipped."
  4. Finish with a short summary: how many emails were scanned, how many parcels were new vs. updated.
- The model never decides *which* steps to take — the order is fixed in code, so results are consistent.
- **Result:** a real, up-to-date parcel list built from your actual inbox.

### Step 5 — Run it and look at it from the terminal
- `npm run classify -- --days 7 --max 20` → scans recent mail, updates the database, and prints a short table
  of parcels (tracking, carrier, status, last update).
- `npm run try -- parcels` → shows the parcels still on their way.
- `npm run try -- decisions` → shows the most recent decisions the agent made.
- **Result:** you can drive and inspect everything without any web page yet.

### Step 6 — Still strictly read-only on your mailbox
- The Classifier **reads** Gmail and **writes only to the local database**. There is still no ability to send,
  edit, or delete email — by design, there simply are no tools for that.

### A design note that keeps testing easy
Just like Stage 1, each piece accepts its dependencies (the Gmail client, the AI helper, the database) as
inputs. That means tests can plug in **fakes** — a canned inbox and a canned AI — and check the whole flow
**without the network and without spending a cent**.

---

## Part B — Your part (data + external services)

You already did the Gmail login in Stage 1. Stage 2 adds **one** thing: an OpenAI API key. ~5 minutes.

### B1 — Create an OpenAI account and key
1. Go to [platform.openai.com](https://platform.openai.com/) and sign in (or sign up).
2. Open **API keys → Create new secret key**, and copy it (it's shown only once).
3. Add a small amount of **credit/billing**. Classifying with a tiny model costs fractions of a cent, but the
   account needs funds to make any calls.

### B2 — Put the key in a `.env` file
- In the `gmail-agent/` folder, create a file named `.env` containing:
  ```
  OPENAI_API_KEY=sk-...        # your key
  OPENAI_MODEL=gpt-4.1-nano    # small and cheap; change here anytime, no code edits
  ```
- This file is already git-ignored — **never commit or share it**.

### B3 — (Optional) give me one or two real senders for testing
- If you tell me 1–2 real parcel senders you actually receive (e.g. `noreply@dhl.com`, `info@inpost.pl`,
  Allegro/Amazon), I can write more realistic end-to-end checks and a better demo.

### What stays secret (never commit / never share)
`credentials.json`, `data/token.json`, the `.env` file, and the database file `data/gmail-agent.db`. All are
git-ignored. Your OpenAI key only ever lives in `.env` — never inside prompts or code.

---

## Part C — Testing procedure

Same three layers as Stage 1, using **Vitest**. Fakes for the AI and Gmail mean the everyday tests run with
no network and **no cost**.

```
tests/
├── unit/          ← pure logic: database helpers (in-memory), the result shape, status wording
├── integration/   ← the Classifier with a FAKE AI + FAKE Gmail + in-memory database (no network)
└── e2e/           ← the real OpenAI + your real inbox (runs only when a key + login exist)
```

Run commands:
- `npm test` — unit + integration (fast, safe, free, no account needed).
- `npm run test:e2e` — the real checks (only after `npm run auth` and with `OPENAI_API_KEY` set).

### C1 — Unit tests (no Gmail, no OpenAI)
| Area | What we assert |
| :-- | :-- |
| Parcels memory | Saving a parcel creates a row; saving the same tracking number with a **new** status appends to the history and updates "last update"; the **same** status does **not** duplicate the history; "active parcels" excludes delivered ones. |
| Decisions log | Recording a decision stores a row; "last N decisions" returns them newest-first. |
| Result shape | A correct AI answer parses cleanly; missing optional fields are fine; an out-of-range status value is rejected. |
| Status wording | Variants like "Out for delivery" / "w doręczeniu" map to one canonical status; anything unrecognised becomes "unknown." |
| Candidate search | "last N days" / "unread only" turn into the correct inputs for the Stage 1 search. |

### C2 — Integration tests (Classifier + fakes, still no network)
We inject a **fake AI** (returns canned answers) and a **fake Gmail** (canned emails), plus an in-memory
database, so we exercise the whole flow offline.

| Scenario | What we assert |
| :-- | :-- |
| A courier email (DHL, has a tracking number) | The parcel is saved with the right tracking/carrier/status; a "tracked" decision is logged; the summary reports success with counts. |
| A non-courier email (newsletter) | Nothing is saved to parcels; a "skipped" decision is logged. |
| An update to a known parcel | A second email with a **new** status grows that parcel's history by one and updates its current status. |
| The AI errors out on one email | No crash — that email is skipped with a clear note, and the rest are still processed. |
| Parcel-related but no tracking number | No parcel row is created (there's no key to store it under); a decision is still logged. |

Why this matters: it proves the logic and the saving behaviour are correct **without your real inbox** and
**without any OpenAI cost** — so these run in seconds and could run in CI.

### C3 — End-to-end tests (real OpenAI + real inbox)
These run only when both your login (`data/token.json`) and your `OPENAI_API_KEY` are present — otherwise they
**skip automatically**, so the normal test run never breaks.

E2E checklist (also a manual acceptance walkthrough):
1. **Key works:** one call to the AI helper on a fixed sample courier text returns the correct structured
   answer (proves OpenAI + the adapter are wired up).
2. **Full run:** `npm run classify -- --days 14 --max 10` on your inbox populates real parcels; `npm run try --
   parcels` shows them.
3. **No duplicates:** running it again on the same mail does **not** duplicate history (same status).
4. **Consistent keys:** classifying the same email twice yields the same tracking number (the database key).

### C4 — What "passing" means for Stage 2
- All unit + integration tests green (`npm test`); the E2E checklist passes on your real inbox.
- The database holds `parcels` (with history) and `decisions`; "active parcels" works.
- The AI provider is isolated (swap the model via `.env`); the agent still has no write access to Gmail; all
  secrets stay out of the repository.

---

## Quick reference — who does what

| Step | You (Part B) | Me (Part A) |
| :-- | :-- | :-- |
| Create an OpenAI account + API key | ✅ | |
| Add the key to `.env` (model `gpt-4.1-nano`) | ✅ | |
| (Optional) provide a real parcel sender | ✅ | |
| Add libraries, write all code & tests | | ✅ |
| Build the AI adapter, database, and Classifier | | ✅ |
| Run/verify tests, deliver the working parcel list | | ✅ |

---

## What this unlocks next (not part of Stage 2)
- **Stage 3:** a heartbeat that runs the Classifier automatically every few minutes, plus a deeper "Tracker"
  that writes day summaries.
- **Stage 4:** a simple web dashboard (parcels + summaries + decision history).
- **Stage 5:** context-compression memory and model/cost tuning.
