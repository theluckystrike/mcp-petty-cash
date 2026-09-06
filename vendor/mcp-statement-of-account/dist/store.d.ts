/**
 * This server owns exactly one thing: a small register of the statements that were
 * BUILT, under `${XDG_DATA_HOME:-~/.local/share}/mcp-servers/statement-of-account/`.
 *
 * Every figure a statement prints is read from somewhere else -- the invoice store, the
 * credit note store and the deposit store -- and none of those is ever written to from
 * here. A statement of account is a view over books that other servers own; a second
 * copy of a balance is a second number to be wrong.
 *
 * The register exists for two reasons and no others: so the free tier can be metered on
 * distinct statements rather than on repeated renderings of the same one, and so a
 * statement that was sent to a client can be looked up later with the closing balance it
 * actually carried. Nothing reads it to compute a balance.
 *
 * Reads go through `readJsonFile` from `@theluckystrike/mcp-invoice/lib`, so a register
 * that is not JSON is quarantined byte-for-byte as `<file>.corrupt-<timestamp>` with a
 * `.corrupt` marker beside it, and every later call fails loudly instead of treating a
 * register that is still on disk as "no statements". Writes are tmp + rename.
 */
/** One statement that was built, exactly as it was handed over. */
export interface StatementRecord {
    /** `STMT-<YYYY>-<NNNN>`, allocated per year of the period end. */
    id: string;
    client_id?: string;
    client_name: string;
    from: string;
    to: string;
    currency: string;
    opening_minor: number;
    invoiced_minor: number;
    paid_minor: number;
    credited_minor: number;
    closing_minor: number;
    /** Movement rows in the period, excluding the opening balance line. */
    movements: number;
    /** The calendar month the statement was first built, `YYYY-MM`. What the free tier meters. */
    built_month: string;
    built: string;
    updated: string;
}
export declare function dataDir(): string;
export declare function lockPath(): string;
export declare function getStatements(): StatementRecord[];
export declare function setStatements(v: StatementRecord[]): void;
/**
 * The key a statement is identified by. A statement is one client, one currency and one
 * period, so re-rendering the same three values updates the row it already has rather
 * than allocating a second id: a client who asks for the September statement twice has
 * one September statement, and the free tier must not charge for the second look.
 */
export declare function statementKey(clientName: string, from: string, to: string, currency: string): string;
export declare function findStatement(list: StatementRecord[], key: string): StatementRecord | undefined;
/**
 * Allocate the next statement id: `STMT-<YYYY>-<NNNN>`.
 *
 * The counter is per year and is written BEFORE the record is stored, so a crash burns
 * an id rather than reusing one. Ids already in the register are also scanned, so a
 * restored or hand-edited register cannot reissue a number that is already on a
 * statement sitting in a client's inbox.
 */
export declare function nextStatementId(year: string, existing: string[]): string;
