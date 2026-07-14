# How to check your Gmail — simple protocol

Follow this every time you want the agent to read your inbox. No technical knowledge needed.

## The one rule that matters

**Always work from the `gmail-agent` folder.**

The full path is:

```
c:\Users\sebas\OneDrive\Pulpit\Tools\AI\Gmail agent\gmail-agent
```

The login key (`credentials.json`) and your saved login (`data\token.json`) live inside that
folder. If a command runs from anywhere else, it can't find your login and you get an
"authentication failure" — even though nothing is actually broken.

---

## Everyday steps (do this each time)

1. Open a terminal **in the `gmail-agent` folder** (in VSCode: right-click the `gmail-agent`
   folder → "Open in Integrated Terminal").

2. Run the thing you want:

   - See your labels (quick test that login works):
     ```
     npm run try -- labels
     ```
   - Search your mail, e.g. unread from DHL:
     ```
     npm run try -- search --from dhl.com --unread
     ```
   - Read one email or thread:
     ```
     npm run try -- read --id <id> --detail full
     ```
   - Run the parcel scan (the main job):
     ```
     npm run classify -- --days 7 --max 20
     ```

3. If you see `"success": true` near the top of the output — it worked.

---

## First-time login (and the rare "please log in again")

You only do this once. Repeat it **only** if the agent says authorization is missing or expired.

1. Be in the `gmail-agent` folder.
2. Run:
   ```
   npm run auth
   ```
3. A browser window opens. Pick your Google account (**seb.mihaljev@gmail.com**) and approve
   **read-only** access.
4. You'll see `Authorized. Token saved`. Done — go back to the everyday steps.

> Note: Google may force a fresh login every so often (this is normal for a personal/test app).
> If that happens, just run `npm run auth` again. It does **not** mean anything is broken.

---

## Using Gmail from inside the Claude chat (the MCP tools)

If you ask Claude in the editor to check your mail (instead of typing commands yourself), it uses
the same login behind the scenes. This used to fail every time because of a path problem — that
bug is now fixed. If it ever fails again:

1. First make sure the plain command works: open a terminal in `gmail-agent` and run
   `npm run try -- labels`.
2. If that works but the chat tools don't, fully close and reopen VSCode so it reloads the agent.
3. If it still fails, run `npm run auth` once more.

---

## Quick troubleshooting

| What you see | What it means | What to do |
|---|---|---|
| `"success": true` | Working fine | Nothing — you're good |
| "Authorization is missing or expired" | Not logged in, or login expired | Run `npm run auth` in the `gmail-agent` folder |
| "auth/permission" / rejected | Google declined | Run `npm run auth`, approve read-only access |
| "rate limit" | Too many requests too fast | Wait ~10 seconds, try again |
| Command "not found" / wrong folder errors | You're in the wrong folder | Go to the `gmail-agent` folder and retry |

---

## What this agent can and cannot do (by design)

- It can **only read** your mail. It can never send, change, or delete anything.
- It only ever sees your account with **read-only** permission.
- Your keys and login stay on your computer in the `gmail-agent` folder and are never shared.
