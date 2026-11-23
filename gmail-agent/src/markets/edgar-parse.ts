/**
 * Pure parsers for SEC EDGAR documents of Strategy / MicroStrategy (CIK 0001050446): 8-K holdings
 * statements and the cover page of 10-Q / 10-K. No I/O and no imports with side effects, so both the
 * hand-run history builder and the in-app holdings reader can share them.
 */

export const STRATEGY_CIK = "1050446";
export const STRATEGY_CIK_PADDED = "0001050446";

/** The 10-for-1 stock split took effect on this date (first split-adjusted trading day). */
export const SPLIT_DATE = "2024-08-08";
export const SPLIT_FACTOR = 10;

export function submissionsUrl(): string {
  return `https://data.sec.gov/submissions/CIK${STRATEGY_CIK_PADDED}.json`;
}

/** Document inside a filing; the accession number is given with dashes, as in the submissions list. */
export function archiveUrl(accession: string, name: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${STRATEGY_CIK}/${accession.replace(/-/g, "")}/${name}`;
}

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', ndash: "-", mdash: "-",
};

/** Turn an EDGAR HTML document into plain text with single spaces. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (whole, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? whole)
    .replace(/[   ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "August 11, 2020" or "Aug. 11, 2020" or "8/11/2020" → "2020-08-11"; undefined if not a date. */
export function parseDateText(text: string): string | undefined {
  const named = /([A-Za-z]{3,9})\.?\s+(\d{1,2})\s*,?\s+(\d{4})/.exec(text);
  if (named) {
    const month = MONTHS.findIndex((m) => m.startsWith(named[1].toLowerCase().slice(0, 3)));
    if (month >= 0 && MONTHS[month].startsWith(named[1].toLowerCase())) {
      return iso(Number(named[3]), month + 1, Number(named[2]));
    }
    if (month >= 0 && named[1].length === 3) return iso(Number(named[3]), month + 1, Number(named[2]));
  }
  const numeric = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(text);
  if (numeric) return iso(Number(numeric[3]), Number(numeric[1]), Number(numeric[2]));
  return undefined;
}

function iso(year: number, month: number, day: number): string | undefined {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return undefined;
  }
  return d.toISOString().slice(0, 10);
}

export function parseCount(text: string): number {
  return Number(text.replace(/,/g, ""));
}

export interface BtcStatement {
  /** The "as of" date of the statement. */
  as_of: string;
  btc_held: number;
  /** The text the number was taken from, for the report. */
  excerpt: string;
}

const DATE_RE = "(?:[A-Za-z]{3,9}\\.?\\s+\\d{1,2}\\s*,?\\s+\\d{4}|\\d{1,2}/\\d{1,2}/\\d{4})";
const COUNT_RE = "(\\d{1,3}(?:,\\d{3})+|\\d+)";

/**
 * Statements of the TOTAL BTC holding, each with its "as of" date:
 *  - sentences: "held an aggregate of approximately X bitcoins", "holds approximately X bitcoins",
 *    "hold a total of X BTC";
 *  - the weekly table: "As of <date> BTC Purchased … Aggregate BTC Holdings …" followed by
 *    purchased, price, average price, HOLDINGS (the 4th number).
 * Purchases ("purchased X bitcoins") are not holdings and never match.
 */
export function findAggregateBtc(text: string): BtcStatement[] {
  const found: BtcStatement[] = [];

  const holdRe = new RegExp(
    `\\b(?:hold|holds|held|holding)\\s+(?:an\\s+)?(?:(?:aggregate|total)\\s+(?:of\\s+)?)?(?:approximately\\s+)?${COUNT_RE}\\s+(?:bitcoins?|BTC)\\b`,
    "gi",
  );
  for (const m of text.matchAll(holdRe)) {
    const before = text.slice(Math.max(0, m.index - 260), m.index + m[0].length);
    const asOf = new RegExp(`as of\\s+(${DATE_RE})`, "gi");
    let last: RegExpExecArray | null = null;
    for (let a = asOf.exec(before); a; a = asOf.exec(before)) last = a;
    let date = last ? parseDateText(last[1]) : undefined;
    if (!date) {
      // "holds approximately 129,699 bitcoins as of June 28, 2022" — the date follows the number.
      const after = new RegExp(`^[^.]{0,40}?as of\\s+(${DATE_RE})`, "i").exec(
        text.slice(m.index + m[0].length),
      );
      date = after ? parseDateText(after[1]) : undefined;
    }
    if (!date) continue;
    found.push({ as_of: date, btc_held: parseCount(m[1]), excerpt: before.slice(-220) });
  }

  // "approximately 132,500 bitcoins held by MicroStrategy and its subsidiaries as of December 27, 2022"
  const heldByRe = new RegExp(
    `${COUNT_RE}\\s+bitcoins?\\s+held\\s+by[^.]{0,120}?as of\\s+(${DATE_RE})`,
    "gi",
  );
  for (const m of text.matchAll(heldByRe)) {
    const date = parseDateText(m[2]);
    if (date) found.push({ as_of: date, btc_held: parseCount(m[1]), excerpt: m[0].slice(-220) });
  }

  // Earnings releases (2024-2025): "190,000 bitcoin holdings at a total cost of $5.93 billion, or
  // $31,224 per bitcoin, as of February 5, 2024".
  const costRe = new RegExp(
    `${COUNT_RE}\\s+bitcoin\\s+holdings\\s+at\\s+a\\s+total\\s+cost[^•▪]{0,160}?as of\\s+(${DATE_RE})`,
    "gi",
  );
  for (const m of text.matchAll(costRe)) {
    const date = parseDateText(m[2]);
    if (date) found.push({ as_of: date, btc_held: parseCount(m[1]), excerpt: m[0].slice(-220) });
  }

  // "bringing its aggregate bitcoin holdings as of July 29, 2025 to approximately 628,791 bitcoins"
  const bringingRe = new RegExp(
    `aggregate\\s+bitcoin\\s+holdings\\s+as of\\s+(${DATE_RE})\\s+to\\s+approximately\\s+${COUNT_RE}\\s+bitcoins?`,
    "gi",
  );
  for (const m of text.matchAll(bringingRe)) {
    const date = parseDateText(m[1]);
    if (date) found.push({ as_of: date, btc_held: parseCount(m[2]), excerpt: m[0].slice(-220) });
  }

  // Earnings releases: "As of May 3, 2026, the Company's digital assets were comprised of
  // approximately 818,334 bitcoins".
  const digitalAssetsRe = new RegExp(
    `as of\\s+(${DATE_RE})\\s*,?\\s+the\\s+company.s\\s+digital\\s+assets\\s+were\\s+comprised\\s+of\\s+approximately\\s+${COUNT_RE}\\s+bitcoins?`,
    "gi",
  );
  for (const m of text.matchAll(digitalAssetsRe)) {
    const date = parseDateText(m[1]);
    if (date) found.push({ as_of: date, btc_held: parseCount(m[2]), excerpt: m[0].slice(-220) });
  }

  // Footnote markers like "(1)" are dropped so the header has no digits before the numbers.
  const tableText = text.replace(/\(\d\)/g, " ");
  const tableRe = new RegExp(
    `as of\\s+(${DATE_RE})\\s+BTC\\s+(?:Purchased|Acquired|Sold)[^$]{0,500}?Aggregate\\s+BTC\\s+Holdings[^\\d$-]*((?:\\$?\\s*(?:[\\d,]+(?:\\.\\d+)?|-)\\s+(?:(?:million|billion)\\s+)?){3})${COUNT_RE}`,
    "gi",
  );
  for (const m of tableText.matchAll(tableRe)) {
    const date = parseDateText(m[1]);
    if (!date) continue;
    found.push({ as_of: date, btc_held: parseCount(m[3]), excerpt: m[0].slice(-220) });
  }

  // Quarter-end filings split the week into two periods; each has its own holdings line:
  // "As of June 30, 2026 Aggregate BTC Holdings Aggregate Purchase Price (in billions) Average
  // Purchase Price 843,775 $63.69 $75,476".
  const splitRe = new RegExp(
    `as of\\s+(${DATE_RE})\\*?\\s+Aggregate\\s+BTC\\s+Holdings[^\\d$-]*${COUNT_RE}\\s+\\$`,
    "gi",
  );
  for (const m of tableText.matchAll(splitRe)) {
    const date = parseDateText(m[1]);
    if (date) found.push({ as_of: date, btc_held: parseCount(m[2]), excerpt: m[0].slice(-220) });
  }
  return found;
}

/** True when the filing reports bitcoin SALES (a "BTC Sold" table), which explains a lower holding. */
export function reportsBtcSales(text: string): boolean {
  return /BTC\s+Sold/i.test(text);
}

export interface CoverShares {
  as_of: string;
  class_a: number;
  class_b: number;
  excerpt: string;
}

/** Class A + class B shares from a 10-Q / 10-K cover page ("As of <date>, ... had X ... Y ..."). */
export function findCoverShares(text: string): CoverShares | undefined {
  // The inline-XBRL header can push the cover page 20k+ characters in; the first match wins.
  // "As of April 24, 2023 , the registrant had 10,994,626 and 1,964,025 shares of class A common
  // stock and class B common stock outstanding, respectively." (EDGAR HTML sometimes splits
  // words, e.g. "a nd".)
  const sentence = new RegExp(
    `as of\\s+(${DATE_RE})\\s*,?\\s+the\\s+r\\s?egistrant\\s+had\\s+${COUNT_RE}\\s+a\\s?nd\\s+${COUNT_RE}\\s+shares\\s+of\\s+class\\s+a\\s+common\\s+stock\\s+and\\s+class\\s+b\\s+common\\s+stock`,
    "i",
  ).exec(text);
  if (sentence) {
    const as_of = parseDateText(sentence[1]);
    if (as_of) {
      return {
        as_of,
        class_a: parseCount(sentence[2]),
        class_b: parseCount(sentence[3]),
        excerpt: sentence[0].slice(0, 300),
      };
    }
  }
  return undefined;
}

/** Share counts reported before the split date are on the old scale. */
export function toPostSplitShares(shares: number, asOf: string): { value: number; factor: number } {
  const factor = asOf < SPLIT_DATE ? SPLIT_FACTOR : 1;
  return { value: shares * factor, factor };
}
