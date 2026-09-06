/**
 * This server owns exactly two files, under
 * `${XDG_DATA_HOME:-~/.local/share}/mcp-servers/cash-book/`:
 *
 *  - `periods.json`, the register of the periods a ledger was built for, which is what
 *    the free tier is metered on;
 *  - `closes.json`, the months that were closed, each with the trial balance snapshot as
 *    it stood at the moment of closing.
 *
 * Nothing else is written anywhere. Every debit and every credit this server reports is
 * DERIVED, on the call, from books other servers own: the invoice ledger, the credit note
 * and purchase order store, the deposit store, the expense ledger, the bank import and
 * the fixed asset register. None of those is ever written back to, and no figure is ever
 * read back out of the two files above to compute a balance. A ledger that stores its own
 * copy of a balance has a second number to be wrong, and the second number is the one that
 * gets believed.
 *
 * The close snapshot is the one exception, and it is deliberately a SNAPSHOT and not a
 * source: it records what the trial balance said on the day the month was closed, so a
 * later change in a sibling store can be seen as a change rather than quietly becoming
 * the new truth. `month_close` compares the two and says so.
 *
 * Reads go through `readJsonFile` from `@theluckystrike/mcp-invoice/lib`, so a register
 * that is not JSON is quarantined byte-for-byte as `<file>.corrupt-<timestamp>` with a
 * `.corrupt` marker beside it. Writes are tmp + rename.
 */
/** One period a ledger was built for. The unit the free tier meters. */
export interface PeriodRecord {
    from: string;
    to: string;
    currency: string;
    /** Posted lines the build produced. */
    lines: number;
    debits_minor: number;
    credits_minor: number;
    /** debits - credits, zero on a ledger that balances. */
    imbalance_minor: number;
    /** The calendar month the period was first built, `YYYY-MM`. What the meter counts. */
    built_month: string;
    built: string;
    updated: string;
}
/** One closed month, with the trial balance as it stood at the close. */
export interface CloseRecord {
    /** `YYYY-MM`. */
    month: string;
    currency: string;
    closed: string;
    debits_minor: number;
    credits_minor: number;
    imbalance_minor: number;
    /** Account id to signed balance in minor units, debit positive. */
    balances: Record<string, number>;
    /** The exceptions that were open at the close, kept verbatim. */
    open_exceptions: string[];
}
export declare function dataDir(): string;
export declare function lockPath(): string;
export declare function getPeriods(): PeriodRecord[];
export declare function setPeriods(v: PeriodRecord[]): void;
export declare function getCloses(): CloseRecord[];
export declare function setCloses(v: CloseRecord[]): void;
/**
 * The key a built period is identified by: one period is one date range in one currency.
 * Rebuilding the same range does not allocate a second row and is never metered again,
 * because the meter is on distinct periods and not on repeated questions about one.
 */
export declare function periodKey(from: string, to: string, currency: string): string;
/**
 * The name a built period is called by in an answer. The register keys on the same three
 * fields, so the id is derived and never stored: a stored id is a second name for the row
 * that can drift from the row it names.
 */
export declare function periodId(from: string, to: string, currency: string): string;
export declare function findPeriod(list: PeriodRecord[], key: string): PeriodRecord | undefined;
export declare function findClose(list: CloseRecord[], month: string, currency: string): CloseRecord | undefined;
