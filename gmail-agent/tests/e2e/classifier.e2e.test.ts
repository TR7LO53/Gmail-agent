import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClassificationSchema } from "../../src/agents/classifier.js";
import { openaiProvider } from "../../src/llm/provider.js";
import { openDb } from "../../src/memory/db.js";
import { listActiveParcels } from "../../src/memory/parcels.js";
import { runClassifier } from "../../src/agents/classifier.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_PATH = path.resolve(__dirname, "../../data/token.json");

const hasApiKey = Boolean(process.env.OPENAI_API_KEY);
const tokenExists = existsSync(TOKEN_PATH);
const SKIP_E2E = !hasApiKey || !tokenExists;

const CLASSIFIER_SYSTEM =
  "You are a parcel email classifier. If the email is about a shipment, extract the structured data. Otherwise set isParcelRelated to false. Always provide confidence and reasoning.";

describe("Classifier E2E (real OpenAI + real inbox)", () => {
  it.skipIf(SKIP_E2E)(
    "adapter: extract() returns valid ClassificationSchema for a courier text",
    async () => {
      const courierText = [
        "From: noreply@dhl.com",
        "Subject: Your DHL package 1234567890 is out for delivery",
        "",
        "Dear customer, your parcel with tracking number 1234567890 is out for delivery today.",
        "Carrier: DHL Express. Expected by end of business day.",
      ].join("\n");

      const result = await openaiProvider.extract(ClassificationSchema, CLASSIFIER_SYSTEM, courierText);

      expect(result.isParcelRelated).toBe(true);
      expect(result.trackingNumber).toBe("1234567890");
      expect(result.carrier).toBe("DHL");
      expect(result.confidence).toBeGreaterThan(0.7);
    },
  );

  it.skipIf(SKIP_E2E)(
    "full run: classify inbox, populate DB, view active parcels",
    async () => {
      const db = openDb(":memory:");

      const result = await runClassifier({ days: 14, maxEmails: 10 }, { llm: openaiProvider, db });

      expect(result.success).toBe(true);
      expect(result.data?.scanned).toBeGreaterThan(0);

      const active = listActiveParcels(db);
      console.log(`E2E: found ${active.length} active parcel(s) in last 14 days.`);
      for (const p of active) {
        console.log(`  ${p.tracking_number} — ${p.carrier} — ${p.status}`);
      }
    },
  );

  it.skipIf(SKIP_E2E)(
    "idempotency: second run on same inbox does not grow parcel history",
    async () => {
      const db = openDb(":memory:");

      await runClassifier({ days: 7, maxEmails: 10 }, { llm: openaiProvider, db });
      const afterFirst = listActiveParcels(db).map((p) => ({ t: p.tracking_number, h: p.history.length }));

      await runClassifier({ days: 7, maxEmails: 10 }, { llm: openaiProvider, db });
      const afterSecond = listActiveParcels(db).map((p) => ({ t: p.tracking_number, h: p.history.length }));

      for (const first of afterFirst) {
        const second = afterSecond.find((p) => p.t === first.t);
        expect(second?.h).toBe(first.h);
      }
    },
  );

  it.skipIf(SKIP_E2E)(
    "consistency: same email text yields the same tracking number on two calls",
    async () => {
      const sampleText = [
        "From: notifications@amazon.pl",
        "Subject: Twoja przesyłka #112-3456789-0123456 jest w drodze",
        "",
        "Twoje zamówienie zostało wysłane. Numer śledzenia: TBA123456789000.",
        "Dostawa spodziewana 2 July 2026.",
      ].join("\n");

      const r1 = await openaiProvider.extract(ClassificationSchema, CLASSIFIER_SYSTEM, sampleText);
      const r2 = await openaiProvider.extract(ClassificationSchema, CLASSIFIER_SYSTEM, sampleText);

      if (r1.isParcelRelated && r2.isParcelRelated) {
        expect(r1.trackingNumber).toBe(r2.trackingNumber);
      }
    },
  );
});
