import { describe, expect, it } from "vitest";
import {
  findAggregateBtc,
  findCoverShares,
  htmlToText,
  joinSnapshots,
  mergeBtcRows,
  toPostSplitShares,
} from "../../src/scripts/build-holdings-history.js";

// Snippets are shortened copies of real Strategy filings on SEC EDGAR.
describe("EDGAR parsing for the holdings history script", () => {
  it("turns EDGAR HTML into plain text", () => {
    expect(htmlToText("<p>As&#160;of&nbsp;June 28, 2022 &amp; <b>x</b></p><style>p{}</style>")).toBe("As of June 28, 2022 & x");
  });

  it("reads 'held an aggregate of approximately X bitcoins' with its as-of date", () => {
    const text =
      "As of June 28, 2022, MicroStrategy, together with its subsidiaries, held an aggregate of approximately 129,699 bitcoins, which were acquired at an aggregate purchase price of approximately $3.98 billion";
    expect(findAggregateBtc(text)).toMatchObject([{ as_of: "2022-06-28", btc_held: 129699 }]);
  });

  it("reads 'holds approximately X bitcoins' and ignores purchases", () => {
    const text =
      "On December 4, 2020, MicroStrategy announced that it had purchased approximately 2,574 bitcoins for $50.0 million. As of December 4, 2020, the Company holds approximately 40,824 bitcoins that were acquired at an aggregate purchase price of $475.0 million";
    expect(findAggregateBtc(text)).toMatchObject([{ as_of: "2020-12-04", btc_held: 40824 }]);
  });

  it("reads the weekly table: the fourth number is the aggregate holding", () => {
    const text =
      "During Period November 9, 2026 to November 15, 2026 As of November 15, 2026 BTC Purchased (1) Aggregate Purchase Price (in millions) (2) Average Purchase Price (2) Aggregate BTC Holdings Aggregate Purchase Price (in billions) (2) Average Purchase Price (2) 485 $ 33.4 $ 68,887 850,849 $ 64.20 $ 75,452 (1) The bitcoin purchases were made";
    expect(findAggregateBtc(text)).toMatchObject([{ as_of: "2026-11-15", btc_held: 850849 }]);
  });

  it("reads the table with 'million' and 'billion' units and 'BTC Acquired'", () => {
    const text =
      "As of April 13, 2025 BTC Acquired (1) Aggregate Purchase Price (2) Average Purchase Price (2) Aggregate BTC Holdings Aggregate Purchase Price (2) Average Purchase Price (2) 3,459 $ 285.8 million $ 82,618 531,644 $ 35.92 billion $ 67,556 (1) The";
    expect(findAggregateBtc(text)).toMatchObject([{ as_of: "2025-04-13", btc_held: 531644 }]);
  });

  it("reads a week with no purchases ('-' placeholders) and a BTC Sold table", () => {
    const none = "As of June 28, 2026 BTC Acquired (1) Aggregate Purchase Price (in millions) (2) Average Purchase Price (2) Aggregate BTC Holdings Aggregate Purchase Price (in billions) (2) Average Purchase Price (2) - $ - $ - 847,363 $ 64.10 $ 75,651";
    expect(findAggregateBtc(none)).toMatchObject([{ as_of: "2026-06-28", btc_held: 847363 }]);
    const sold = "As of August 2, 2026 BTC Sold (1) Aggregate Sale Price (in millions) (2) Average Sale Price (2) Aggregate BTC Holdings Aggregate Purchase Price (in billions) (2) Average Purchase Price (2) 1,638 $104.73 $63,957 842,138 $63.51 $75,419";
    expect(findAggregateBtc(sold)).toMatchObject([{ as_of: "2026-08-02", btc_held: 842138 }]);
  });

  it("reads the second period of a quarter-end week", () => {
    const text =
      "As of June 30, 2026 Aggregate BTC Holdings Aggregate Purchase Price (in billions) (2) Average Purchase Price (2) 846,000 $ 63.82 $ 75,436";
    expect(findAggregateBtc(text)).toMatchObject([{ as_of: "2026-06-30", btc_held: 846000 }]);
  });

  it("reads the earnings-release and 'bringing its aggregate' wordings", () => {
    const earnings =
      "• 190,000 bitcoin holdings at a total cost of $5.93 billion, or $31,224 per bitcoin, as of February 5, 2024 • Total Revenues of $124.5 million";
    expect(findAggregateBtc(earnings)).toMatchObject([{ as_of: "2024-02-05", btc_held: 190000 }]);
    const bringing =
      "bringing its aggregate bitcoin holdings as of July 29, 2025 to approximately 628,791 bitcoins, which were acquired";
    expect(findAggregateBtc(bringing)).toMatchObject([{ as_of: "2025-07-29", btc_held: 628791 }]);
    const digital =
      "As of May 3, 2026, the Company’s digital assets were comprised of approximately 818,334 bitcoins, with an original cost basis";
    expect(findAggregateBtc(digital)).toMatchObject([{ as_of: "2026-05-03", btc_held: 818334 }]);
  });

  it("reads '<N> bitcoins held by … as of <date>'", () => {
    const text = "approximately 132,500 bitcoins held by MicroStrategy and its subsidiaries as of December 27, 2022 were acquired";
    expect(findAggregateBtc(text)).toMatchObject([{ as_of: "2022-12-27", btc_held: 132500 }]);
  });

  it("finds nothing in a filing that only mentions bitcoin", () => {
    expect(findAggregateBtc("bitcoin held by the Company, with bitcoin serving as the primary treasury reserve asset")).toEqual([]);
  });

  it("reads class A + class B from the cover page, even with split words", () => {
    expect(
      findCoverShares("As of April 24, 2023 , the registrant had 10,994,626 and 1,964,025 shares of class A common stock and class B common stock outstanding, respectively."),
    ).toMatchObject({ as_of: "2023-04-24", class_a: 10994626, class_b: 1964025 });
    expect(
      findCoverShares("As of May 2, 2025, the registrant had 253,763,053 a nd 19,640,250 shares of class A common stock and class B common stock outstanding"),
    ).toMatchObject({ class_a: 253763053, class_b: 19640250 });
    expect(
      findCoverShares("As of July 31, 2025, the r egistrant had 263,912,697 and 19,640,250 shares of class A common stock and class B common stock outstanding"),
    ).toMatchObject({ as_of: "2025-07-31", class_a: 263912697 });
  });

  it("multiplies share counts dated before the 2024-08-08 split by 10", () => {
    expect(toPostSplitShares(1000, "2024-07-25")).toEqual({ value: 10000, factor: 10 });
    expect(toPostSplitShares(1000, "2024-08-07")).toEqual({ value: 10000, factor: 10 });
    expect(toPostSplitShares(1000, "2024-08-08")).toEqual({ value: 1000, factor: 1 });
  });

  it("keeps one row per as-of date (latest filing) and reports conflicts", () => {
    const base = { form: "8-K", accession: "a" };
    const { rows, conflicts } = mergeBtcRows([
      { ...base, date: "2021-01-02", btc_held: 10, filed: "2021-01-03" },
      { ...base, date: "2021-01-01", btc_held: 5, filed: "2021-01-02" },
      { ...base, date: "2021-01-02", btc_held: 11, filed: "2021-01-04", accession: "b" },
    ]);
    expect(rows.map((r) => [r.date, r.btc_held])).toEqual([["2021-01-01", 5], ["2021-01-02", 11]]);
    expect(conflicts).toHaveLength(1);
  });

  it("carries the latest earlier share count forward and never uses a later one", () => {
    const shares = [
      { as_of: "2020-07-20", class_a: 100, class_b: 20, form: "10-Q", accession: "x" },
      { as_of: "2020-10-19", class_a: 200, class_b: 20, form: "10-Q", accession: "y" },
    ];
    const rows = [
      { date: "2020-08-11", btc_held: 1, form: "8-K", accession: "a", filed: "2020-08-11" },
      { date: "2020-10-19", btc_held: 2, form: "8-K", accession: "b", filed: "2020-10-20" },
    ];
    const joined = joinSnapshots(rows, shares);
    expect(joined.map((s) => s.shares_outstanding)).toEqual([1200, 2200]);
    expect(joined[0].shares_source).toMatchObject({ accession: "x", as_of: "2020-07-20", split_factor: 10 });
    expect(() => joinSnapshots([{ ...rows[0], date: "2020-01-01" }], shares)).toThrow(/No share count/);
  });
});
