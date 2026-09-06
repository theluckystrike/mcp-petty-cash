import { type Invoice } from "@theluckystrike/mcp-invoice/lib";
import { type CreditNote, type PurchaseOrder } from "@theluckystrike/mcp-billing-docs/lib";
import { type Deposit } from "@theluckystrike/mcp-deposits/lib";
import { type Asset } from "@theluckystrike/mcp-asset-register/lib";
/**
 * The six sibling stores, read READ-ONLY and BEST EFFORT.
 *
 * A cash book is not a place money is entered. It is the one place the money already
 * entered elsewhere is stated twice, once as a debit and once as a credit. Two rules
 * follow and both are load-bearing:
 *
 * 1. Nothing here writes. Not a payment, not a status, not a counter, not into any of the
 *    six stores below. A ledger that also wrote would be posting entries against itself.
 *
 * 2. A sibling store that is missing or empty is reported, never fatal: the common case on
 *    a real machine is a user who invoices and has never installed the deposit server, and
 *    their ledger is correct, it simply has no deposit line. A store that is on disk and
 *    did NOT parse is a different thing: money exists that could not be read, so the
 *    failure is carried into every answer as a named source error. An unreadable store is
 *    never read as an empty one, because that turns a figure that could not be computed
 *    into a figure of zero, and a zero in a ledger balances perfectly while being wrong.
 *
 * There is no fatal store here, not even the invoice ledger: a business with only bank
 * imports and expenses still has a cash book. What a missing store costs is stated on the
 * answer instead, per store and in words.
 *
 * Four of the six publish a `./lib` entry point and are read through it. `expense-tracker`
 * and `bank-statement` publish none (their `exports` map has only `.`), so their
 * `data.json` is read from the shared XDG data root by path, parsed defensively and NEVER
 * written, which is exactly what those two servers already do to each other in
 * `readBankTransactions` and `readExpenses`.
 */
/** The expense record shape servers/expense-tracker/src/store.ts declares, as far as it is used here. */
export interface ExpenseRow {
    id: string;
    date: string;
    /** Gross, POSITIVE, in minor units. VAT-inclusive when `vat_rate` is set. */
    amount_minor: number;
    currency: string;
    category?: string;
    merchant?: string;
    /** Percent. Absent means the amount carries no VAT split at all. */
    vat_rate?: number;
}
/** The transaction shape servers/bank-statement/src/store.ts declares, as far as it is used here. */
export interface BankRow {
    id: string;
    account: string;
    date: string;
    description: string;
    /** SIGNED minor units: a debit (money out) is negative, a credit (money in) positive. */
    amount_minor: number;
    currency: string;
    counterparty?: string;
    category?: string;
}
export interface Source<T> {
    rows: T[];
    error?: string;
    ok: boolean;
}
export interface SourceSet {
    invoices: Source<Invoice>;
    credit_notes: Source<CreditNote>;
    purchase_orders: Source<PurchaseOrder>;
    deposits: Source<Deposit>;
    expenses: Source<ExpenseRow>;
    bank: Source<BankRow>;
    assets: Source<Asset>;
}
export declare function readSources(): SourceSet;
/** One line per store, for the `sources` block every answer carries. */
export declare function sourceReport(s: SourceSet): Array<{
    store: string;
    read: boolean;
    rows: number;
    error?: string;
}>;
/**
 * What an unreadable store costs, named store by store and account by account. A ledger
 * short one store is not wrong by a rounding error, it is wrong by everything that store
 * held, and it still balances, because both legs of the missing entry are missing.
 */
export declare function degradedNotes(s: SourceSet): string[];
