# Setup Guide — Discord bot + USDA FoodData Central (Ggent food logging)

This is the one-time account setup for Stage 6 (logging food by chatting with Ggent).
Do the parts **in this order** — the food API first, because it lets you test food logging
from the terminal before you touch Discord.

Everything secret goes into **`gmail-agent/.env`** (already open in your editor). That file is
gitignored — never share it or paste tokens into chat.

---

## Part A — USDA FoodData Central (calories + macros) — ~3 min

USDA FoodData Central is a **free** US-government food database. Ggent uses your OpenAI key to
split a meal into foods + portion grams, then looks up each food's nutrients here. (Nutritionix,
used earlier, is no longer free — this replaces it.)

1. Open **https://fdc.nal.usda.gov/api-key-signup.html** in your browser.
2. Fill in your name + email and submit. The **API key** arrives by **email instantly**
   (it's a data.gov key).
3. Copy the key — it's your `USDA_API_KEY` (you'll paste it into `.env` in Part C).

> Limits: ~1,000 requests/hour on the free key — far more than you'll use. Ggent makes roughly
> one request per food in a message.
>
> Quick test without signing up: you can temporarily set `USDA_API_KEY=DEMO_KEY`, but it's
> heavily rate-limited — get your own free key for real use.

**You can already test this half** once the key is in `.env` (see Part D, step 1) — no Discord needed.

---

## Part B — Discord bot — ~10–15 min

You'll create a bot, get its token, allow it to read messages, add it to a server so you can
talk to it, and grab your own user id.

### B1. Create the application + bot
1. Go to **https://discord.com/developers/applications** and log in with your Discord account
   (if you don't have Discord, get it free at https://discord.com first).
2. Click **New Application** (top right). Name it **Ggent**, tick the terms box, **Create**.
3. In the left sidebar, click **Bot**.
   - Under **Token**, click **Reset Token** → **Yes, do it!** → then **Copy**.
     *(This is shown only once — copy it now. It's your `DISCORD_BOT_TOKEN`.)*
     *(Older portals: click **Add Bot** first, then reset/copy the token.)*
   - Optional: turn **Public Bot** OFF (so only you can add it).

### B2. Enable the Message Content Intent (REQUIRED)
Still on the **Bot** page, scroll to **Privileged Gateway Intents**:
1. Turn **MESSAGE CONTENT INTENT** → **ON**.
2. Click **Save Changes**.
> Without this, the bot connects but can't read what you type — this is the #1 setup mistake.

### B3. Invite the bot to a server
To message a bot you must share a server with it (even a private one just for you).
1. **Create your server FIRST** (otherwise the invite page's "Add to Server" list is empty — it
   only shows servers you own). In the Discord app, click the green **+** on the left →
   **Create My Own** → **For me and my friends** → name it → **Create**. Use the **same Discord
   account** you're logged into in the Developer Portal.
2. Back in the Developer Portal: sidebar → **OAuth2** → **URL Generator**.
3. Under **Scopes**, tick **bot**.
4. Under **Bot Permissions**, tick: **View Channels**, **Send Messages**, **Read Message History**.
5. Copy the **Generated URL** at the bottom, paste it in your browser, choose your server,
   **Authorize**, complete the captcha.
6. The bot now appears in your server's member list (offline until you run Ggent).

### B4. Get YOUR Discord user id (so only you can log food)
1. In the Discord app: **User Settings** (gear, bottom-left) → **Advanced** → turn on
   **Developer Mode**.
2. Right-click **your own username** (in any message or the member list) → **Copy User ID**.
   *(It's a long number.)* This is `DISCORD_ALLOWED_USER_ID`.

### B5. How you'll actually talk to it
- **Simplest:** type in a text channel of your server that the bot can see.
- **DM:** right-click the bot → **Message** (works because you share a server).
- **Voice note:** on your phone, open the chat and **hold the microphone** icon to record; on
  desktop, use the mic button in the message bar. Ggent detects the audio attachment, transcribes
  it (Polish), and logs it.

---

## Part C — Put it all in `.env` — ~2 min

Open **`gmail-agent/.env`** and add these lines (use your real values, **no `#` in front**,
no quotes, no spaces around `=`). Keep your existing `OPENAI_API_KEY` line.

```
DISCORD_BOT_TOKEN=your-bot-token-from-B1
DISCORD_ALLOWED_USER_ID=your-numeric-id-from-B4
USDA_API_KEY=your-key-from-A
NUTRITION_GOAL_KCAL=2000
NUTRITION_GOAL_PROTEIN_G=150
NUTRITION_GOAL_CARBS_G=200
NUTRITION_GOAL_FAT_G=70
```

Adjust the four `NUTRITION_GOAL_*` numbers to your own daily targets. Save the file.

---

## Part D — Test it — ~5 min

Run these in a terminal inside `gmail-agent/` (or just use the desktop **Ggent** button for the
full thing).

1. **Food lookup only (no Discord):**
   ```
   npm run try -- food "2 eggs and toast"
   npm run try -- food today
   ```
   You should see items with calories, then a "Today: … / … kcal" line. If this works, your
   USDA key is good.

2. **Discord bot:**
   ```
   npm run bot
   ```
   Wait for `Discord bot online as Ggent#1234`. Then, in your server/DM, send:
   - `2 eggs and toast` → the bot replies "Zapisano: … Dziś: …".
   - `pierś z kurczaka 200g i ryż` (Polish) → it translates + logs.
   - `today` → shows today's totals. `undo` → removes the last entry.
   - a **voice note** describing a meal → transcribed, translated, logged.

3. **Everything at once:** double-click the desktop **Ggent** button. The console should show the
   dashboard URL **and** `Discord bot online …`. The dashboard's **Today's nutrition** section
   updates live as you log.

---

## Part E — Troubleshooting

| Symptom | Fix |
|---|---|
| Invite page: **"Add to Server" list is empty** | You don't own a server yet. Create one first (B3.1) in the SAME account, then reload the invite URL. Still empty → log into discord.com with the correct account, or open the URL inside the Discord app. |
| Bot start error: *"Used disallowed intents"* | Enable **Message Content Intent** (B2) and save. |
| Bot shows online but never replies | Check `DISCORD_ALLOWED_USER_ID` is exactly your id (B4); make sure you share a server (B3); confirm Message Content Intent is on. |
| `npm run bot` says "DISCORD_BOT_TOKEN not set — skipping" | The token line is missing/commented in `.env`. |
| Can't open a DM to the bot | You must share a server — do B3, then DM works. Or just use a channel. |
| USDA `403` / `API_KEY_INVALID` | Wrong or missing `USDA_API_KEY`. Re-copy the key from the signup email. |
| Reply: "Nie rozpoznałem jedzenia…" | The database didn't match a food — name it more simply/generically ("rice", "white bread", "chicken breast"). |
| Portions look off | USDA gives accurate per-gram macros; the **grams** are estimated by the AI. Say the weight explicitly ("150g rice", "2 eggs") for precision. |
| Voice note not logged | Make sure it's an actual voice message/audio attachment; check `OPENAI_API_KEY` is set (used for transcription + parsing). |
| `429 Too Many Requests` | Hit the ~1000/hour USDA limit (or you're on `DEMO_KEY`) — wait, or use your own key. |

---

## Part F — Security

- The **bot token** is a password for your bot. If it ever leaks, go to Developer Portal → Bot →
  **Reset Token** and update `.env`.
- Never commit `.env` (it's gitignored) and never paste tokens/keys into chat or screenshots.
- Only your `DISCORD_ALLOWED_USER_ID` can log food; messages from anyone else are ignored.
