import "./env.js";
import { parseArgs } from "node:util";
import { authorize } from "./gmail/auth.js";
import { gmailSearch } from "./tools/gmail-search.js";
import { gmailRead } from "./tools/gmail-read.js";
import { gmailListLabels } from "./tools/gmail-labels.js";
import { openaiProvider } from "./llm/provider.js";
import { openDb } from "./memory/db.js";
import { listActiveParcels, listAllParcels } from "./memory/parcels.js";
import { listDecisions } from "./memory/decisions.js";
import { getMeta } from "./memory/meta.js";
import { listTodaysEmails, listUnread, startOfLocalDayIso } from "./memory/emails.js";
import { listTodaysFood, todaysTotals } from "./memory/food.js";
import { nutritionGoals } from "./config.js";
import { logMeal } from "./agents/nutrition-log.js";
import { usdaProvider } from "./nutrition/provider.js";
import { runClassifier } from "./agents/classifier.js";
import { runTracker, generateDailySummary } from "./agents/tracker.js";
import { runHeartbeatTick, startHeartbeat } from "./core/heartbeat.js";

function print(obj: unknown): void {
  console.log(JSON.stringify(obj, null, 2));
}

function fmtDate(iso: string): string {
  // Render in the machine's LOCAL timezone (stored values are UTC ISO strings).
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString();
}

const USAGE = `Gmail Agent CLI (read-only)

Commands:
  auth                            One-time login (opens browser, saves data/token.json)
  labels [--no-system]            List Gmail labels
  search [filters]                Search the inbox. Filters:
      --from <addr>               sender contains
      --to <addr>                 recipient (repeatable)
      --subject <text>            subject contains
      --query <text>              free-text Gmail query
      --label <name>              filter by label
      --category <name>           filter by Gmail tab (primary|social|promotions|updates|forums)
      --after <YYYY/MM/DD>        newer than date
      --before <YYYY/MM/DD>       older than date
      --attachment                only with attachments
      --unread                    only unread
      --max <n>                   max results (default 25)
      --page <token>              next-page token
  read --id <id> [--detail summary|full]
                                  Read a thread (id may be a message or thread id)
  classify [--days <n>] [--max <n>] [--unread]
                                  Scan recent emails, classify parcels, save to DB
  track [--tracking <no>]         Deeper status refresh of active parcels (or one tracking no.)
  summary                         Generate + show the daily parcel digest
  heartbeat [--interval <min>] [--once] [--max <n>]
                                  Proactive loop: classify → track → summarise every N min
                                  (--once runs a single tick and exits)
  food "<what you ate>"           Log a meal (calories + macros via Nutritionix)
  food today                      Show today's calories/macros vs goals
  inbox                           Show today's emails and current unread mail (from DB)
  parcels [--all]                 Show tracked parcels (active only, or --all)
  decisions [--limit <n>]         Show recent classification decisions (default 20)
`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case "auth": {
      // Always force a fresh browser consent flow. `npm run auth` is only ever run to (re)connect,
      // and a stale/expired token.json would otherwise be silently re-used (see authorize()).
      await authorize({ force: true });
      console.log("✅ Authorized. Fresh token saved to data/token.json");
      return;
    }

    case "labels": {
      const { values } = parseArgs({
        args: rest,
        options: { "no-system": { type: "boolean" } },
        allowPositionals: false,
      });
      print(await gmailListLabels({ includeSystem: values["no-system"] ? false : undefined }));
      return;
    }

    case "search": {
      const { values } = parseArgs({
        args: rest,
        options: {
          from: { type: "string" },
          to: { type: "string", multiple: true },
          subject: { type: "string" },
          query: { type: "string" },
          label: { type: "string" },
          category: { type: "string" },
          after: { type: "string" },
          before: { type: "string" },
          attachment: { type: "boolean" },
          unread: { type: "boolean" },
          max: { type: "string" },
          page: { type: "string" },
        },
        allowPositionals: false,
      });
      print(
        await gmailSearch({
          from: values.from,
          to: values.to,
          subject: values.subject,
          query: values.query,
          label: values.label,
          category: values.category,
          after: values.after,
          before: values.before,
          hasAttachment: values.attachment,
          isUnread: values.unread,
          maxResults: values.max ? Number(values.max) : undefined,
          pageToken: values.page,
        }),
      );
      return;
    }

    case "read": {
      const { values } = parseArgs({
        args: rest,
        options: { id: { type: "string" }, detail: { type: "string" } },
        allowPositionals: false,
      });
      if (!values.id) {
        console.error("Usage: read --id <id> [--detail summary|full]");
        process.exit(1);
      }
      const detail = values.detail === "full" ? "full" : values.detail === "summary" ? "summary" : undefined;
      print(await gmailRead({ id: values.id, detail }));
      return;
    }

    case "classify": {
      const { values } = parseArgs({
        args: rest,
        options: {
          days: { type: "string" },
          max: { type: "string" },
          unread: { type: "boolean" },
        },
        allowPositionals: false,
      });

      const db = openDb();
      const result = await runClassifier(
        {
          days: values.days ? Number(values.days) : undefined,
          maxEmails: values.max ? Number(values.max) : undefined,
          unreadOnly: values.unread,
        },
        { llm: openaiProvider, db },
      );

      print(result);

      if (result.success && result.data) {
        const { scanned, tracked, updated, skipped, deduped, errors } = result.data;
        console.log(
          `\nSummary: ${scanned} scanned → ${tracked} new parcels, ${updated} updated, ${skipped} skipped, ${deduped} deduped, ${errors} errors`,
        );
        const active = listActiveParcels(db);
        if (active.length > 0) {
          console.log("\nActive parcels:");
          for (const p of active) {
            console.log(`  ${p.tracking_number}  ${p.carrier}  ${p.status}  (${fmtDate(p.last_update)})`);
          }
        }
      }
      return;
    }

    case "parcels": {
      const { values } = parseArgs({
        args: rest,
        options: { all: { type: "boolean" } },
        allowPositionals: false,
      });
      const db = openDb();
      const parcels = values.all ? listAllParcels(db) : listActiveParcels(db);
      if (parcels.length === 0) {
        console.log(values.all ? "No parcels in database." : "No active parcels. Run `npm run classify` first.");
        return;
      }
      console.log(`${values.all ? "All" : "Active"} parcels (${parcels.length}):\n`);
      for (const p of parcels) {
        console.log(`  ${p.tracking_number}`);
        console.log(`    carrier:  ${p.carrier}`);
        console.log(`    status:   ${p.status}`);
        console.log(`    updated:  ${fmtDate(p.last_update)}`);
        if (p.history.length > 1) {
          console.log(`    history:  ${p.history.map((h) => h.status).join(" → ")}`);
        }
        console.log();
      }
      return;
    }

    case "decisions": {
      const { values } = parseArgs({
        args: rest,
        options: { limit: { type: "string" } },
        allowPositionals: false,
      });
      const db = openDb();
      const decisions = listDecisions(db, values.limit ? Number(values.limit) : 20);
      if (decisions.length === 0) {
        console.log("No decisions logged yet. Run `npm run classify` first.");
        return;
      }
      console.log(`Last ${decisions.length} decisions:\n`);
      for (const d of decisions) {
        const icon = d.action_taken === "track" ? "📦" : "⏭️ ";
        console.log(`  ${icon} [${fmtDate(d.timestamp)}] ${d.action_taken.toUpperCase()} — ${d.agent_reasoning ?? ""}`);
        if (d.outcome) console.log(`     → ${d.outcome}`);
      }
      return;
    }

    case "track": {
      const { values } = parseArgs({
        args: rest,
        options: { tracking: { type: "string" } },
        allowPositionals: false,
      });
      const db = openDb();
      const result = await runTracker(
        { trackingNumber: values.tracking },
        { llm: openaiProvider, db },
      );
      print(result);
      if (result.success && result.data) {
        const { checked, updated, delivered, errors } = result.data;
        console.log(
          `\nTracker: ${checked} checked → ${updated} updated, ${delivered} delivered, ${errors} errors`,
        );
        const active = listActiveParcels(db);
        if (active.length > 0) {
          console.log("\nActive parcels:");
          for (const p of active) {
            console.log(`  ${p.tracking_number}  ${p.carrier}  ${p.status}  (${fmtDate(p.last_update)})`);
          }
        }
      }
      return;
    }

    case "food": {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { today: { type: "boolean" } },
        allowPositionals: true,
      });
      const db = openDb();
      const g = nutritionGoals();

      // `food today` (positional) or `food --today` (flag; the flag can be swallowed by npm on Windows).
      const wantToday =
        values.today || (positionals.length === 1 && positionals[0].toLowerCase() === "today");

      if (wantToday) {
        const t = todaysTotals(db, startOfLocalDayIso());
        console.log(
          `Today: ${Math.round(t.kcal)}/${g.kcal} kcal · ${t.protein_g}/${g.protein_g}g P · ${t.carbs_g}/${g.carbs_g}g C · ${t.fat_g}/${g.fat_g}g F`,
        );
        const rows = listTodaysFood(db, startOfLocalDayIso());
        for (const it of rows) console.log(`  ${it.name} — ${Math.round(it.kcal)} kcal`);
        if (rows.length === 0) console.log("  (nothing logged today)");
        return;
      }

      const text = positionals.join(" ").trim();
      if (!text) {
        console.error('Usage: food "2 eggs and toast"   |   food --today');
        process.exit(1);
      }
      const result = await logMeal(text, "text", { llm: openaiProvider, nutrition: usdaProvider, db });
      if (!result.success || !result.data) {
        console.error(result.recovery ?? "Failed to log meal.");
        process.exit(1);
      }
      const r1 = (n: number) => Math.round(n * 10) / 10;
      const d = result.data;
      for (const it of d.items) {
        if (it.matched === false) {
          console.log(`• ${it.original ?? it.name} — ${it.qty} g  → NOT FOUND in database`);
          continue;
        }
        console.log(`• ${it.original ?? it.name} — ${it.qty} g  → ${it.name}`);
        console.log(`    ${Math.round(it.kcal)} kcal · ${r1(it.protein_g)} g P · ${r1(it.carbs_g)} g C · ${r1(it.fat_g)} g F`);
      }
      console.log(
        `\nMeal:  ${Math.round(d.mealTotals.kcal)} kcal · ${r1(d.mealTotals.protein_g)} P / ${r1(d.mealTotals.carbs_g)} C / ${r1(d.mealTotals.fat_g)} F`,
      );
      console.log(
        `Today: ${Math.round(d.dayTotals.kcal)}/${g.kcal} kcal · ${r1(d.dayTotals.protein_g)}/${g.protein_g}g P · ${r1(d.dayTotals.carbs_g)}/${g.carbs_g}g C · ${r1(d.dayTotals.fat_g)}/${g.fat_g}g F`,
      );
      return;
    }

    case "inbox": {
      const db = openDb();
      const today = listTodaysEmails(db, startOfLocalDayIso());
      const unread = listUnread(db);
      console.log(`Today: ${today.length} email(s) · Unread: ${unread.length}\n`);
      if (unread.length > 0) {
        console.log("Unread:");
        for (const e of unread) console.log(`  • ${e.sender ?? "?"} — ${e.subject ?? "(no subject)"}`);
        console.log();
      }
      if (today.length > 0) {
        console.log("Today:");
        for (const e of today) {
          console.log(`  ${e.is_unread ? "•" : " "} ${fmtDate(e.received_at ?? "")}  ${e.sender ?? "?"} — ${e.subject ?? "(no subject)"}`);
        }
      } else {
        console.log("No emails recorded today yet. Run `npm run heartbeat -- --once`.");
      }
      return;
    }

    case "summary": {
      const db = openDb();
      const result = await generateDailySummary({ llm: openaiProvider, db });
      if (result.success && result.data) {
        console.log(result.data.summary);
        const at = getMeta(db, "daily_summary_at");
        if (at) console.log(`\n(generated ${fmtDate(at)})`);
      } else {
        print(result);
      }
      return;
    }

    case "heartbeat": {
      const { values } = parseArgs({
        args: rest,
        options: {
          interval: { type: "string" },
          once: { type: "boolean" },
          max: { type: "string" },
        },
        allowPositionals: false,
      });
      const db = openDb();
      const deps = { llm: openaiProvider, db };
      const maxEmails = values.max ? Number(values.max) : undefined;

      if (values.once) {
        print(await runHeartbeatTick(deps, { maxEmails }));
        return;
      }

      const intervalMin = values.interval ? Number(values.interval) : 5;
      console.log(`Heartbeat started — every ${intervalMin} min. Press Ctrl+C to stop.`);
      const handle = startHeartbeat(deps, {
        intervalMs: intervalMin * 60 * 1000,
        maxEmails,
        onTick: (r) => {
          const d = r.data;
          if (!d) return;
          console.log(
            `[${fmtDate(d.ranAt)}] classify: ${d.classifier.tracked} new / ${d.classifier.updated} upd / ${d.classifier.deduped} dedup · track: ${d.tracker.updated} upd / ${d.tracker.delivered} delivered`,
          );
          if (d.summary) console.log(`  summary: ${d.summary}`);
        },
        onError: (e) => console.error("Heartbeat tick failed:", e),
      });
      process.on("SIGINT", () => {
        console.log("\nStopping heartbeat...");
        handle.stop();
        process.exit(0);
      });
      await new Promise<void>(() => {}); // keep the process alive until Ctrl+C
      return;
    }

    default:
      console.log(USAGE);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
