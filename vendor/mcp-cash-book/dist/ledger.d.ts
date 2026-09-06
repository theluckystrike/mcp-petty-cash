import type { SourceSet } from "./sources.js";
/**
 * The posting engine.
 *
 * Every line below is DERIVED on the call from a document in a sibling store, and carries
 * the server that owns that document, the document's own id and the document's own date.
 * Nothing is entered by hand, nothing is stored, and there is no adjusting journal: a
 * ledger you can type into is a ledger that can disagree with the books it is made of, and
 * the whole value of this server is that it cannot.
 */
export type AccountType = "asset" | "liability" | "income" | "expense" | "contra-asset";
export interface Account {
    id: string;
    name: string;
    type: AccountType;
}
export declare const CASH = "cash";
export declare const RECEIVABLES = "receivables";
export declare const REVENUE = "revenue";
export declare const VAT_OUTPUT = "vat_output";
export declare const VAT_INPUT = "vat_input";
export declare const DEPOSITS_HELD = "deposits_held";
export declare const FIXED_ASSETS = "fixed_assets";
export declare const ACCUMULATED_DEPRECIATION = "accumulated_depreciation";
export declare const DEPRECIATION_EXPENSE = "depreciation_expense";
/** Prefix for the per-category expense accounts, e.g. `expenses:travel`. */
export declare const EXPENSES = "expenses";
export declare function expenseAccount(category?: string): string;
export declare function accountFor(id: string): Account;
/** The normal side of an account: `1` when a debit increases it, `-1` when a credit does. */
export declare function normalSide(type: AccountType): 1 | -1;
export interface Line {
    /** The entry the leg belongs to. Every leg of one entry shares it. */
    entry: string;
    date: string;
    account: string;
    account_name: string;
    debit_minor: number;
    credit_minor: number;
    /** The sibling server that owns the document this line was derived from. */
    source: string;
    /** That document's own id, as it prints on the document. */
    source_id: string;
    description: string;
    currency: string;
    /** The bank transaction that evidences this cash movement, when exactly one does. */
    bank_ref?: string;
}
export type ExceptionKind = "invoice-no-vat-rate" | "entry-does-not-balance" | "bank-debit-unexplained" | "bank-credit-unexplained" | "bank-row-ambiguous" | "deposit-applied-to-unknown-invoice" | "payment-attribution-disagrees" | "credit-note-sign" | "asset-disposal-not-posted" | "cash-without-bank-evidence";
export interface Exception {
    kind: ExceptionKind;
    source: string;
    source_id: string;
    date: string;
    message: string;
}
export interface Memo {
    kind: "purchase-commitment";
    source: string;
    source_id: string;
    date: string;
    amount_minor: number;
    description: string;
}
export interface Ledger {
    from: string;
    to: string;
    currency: string;
    lines: Line[];
    exceptions: Exception[];
    memos: Memo[];
    /** Every currency seen on an in-period document, so a refusal can name them. */
    currencies_seen: string[];
    /** In-period documents skipped because they are in another currency. */
    excluded_rows: number;
    notes: string[];
}
/**
 * Every currency that appears on a document dated inside the period. This is what makes
 * "refuses to mix currencies" a refusal rather than a hope: the caller does not have to
 * know what is in their books for the ledger to notice that two currencies are.
 */
export declare function currenciesInPeriod(s: SourceSet, from: string, to: string): string[];
/**
 * One ledger is one currency, and there is no exchange rate anywhere in this server, so a
 * single figure over a EUR book and a USD one would be invented. When the period holds two
 * currencies and the caller named neither, the build REFUSES and names both.
 */
export declare function pickCurrency(seen: string[], asked: string | undefined, fallback: string): string;
/** Every `YYYY-MM` the period touches, in order. */
export declare function monthsBetween(from: string, to: string): string[];
/**
 * Build the ledger for one period in one currency.
 *
 * The posting rules, in the order they run:
 *
 *  - an invoice issued in the period: debit receivables its total, credit revenue its net
 *    and credit VAT output its tax;
 *  - a credit note issued in the period: the same three accounts, the other way round.
 *    servers/billing-docs stores every money field on a credit note NEGATIVE, which is the
 *    sign a ledger wants, so the magnitudes are read off directly and no row is flipped;
 *  - a payment in the period: debit cash, credit receivables. The rows come from
 *    `paymentRows` in servers/statement-of-account, which is the one place in this repo
 *    that knows `paid_minor` is the authority and `payments[]` only the attribution;
 *  - a payment made by APPLYING a deposit: debit deposits held, credit receivables, and
 *    NOT cash, because the cash came in when the deposit was received;
 *  - a deposit received: debit cash, credit deposits held. A refund is the reverse;
 *  - an expense: debit its category account with the net, debit VAT input with the VAT and
 *    credit cash with the gross. servers/expense-tracker stores the amount VAT-INCLUSIVE,
 *    so the VAT is taken OUT of the gross and is never added on top of it;
 *  - an asset entering service: debit fixed assets, credit cash;
 *  - a month of depreciation: debit depreciation expense, credit accumulated depreciation;
 *  - an open purchase order: a MEMO, never posted. An order is a commitment, not a
 *    transaction: nothing has been delivered and nothing is owed, and a ledger that posts
 *    it reports a liability the business does not have.
 *
 * Bank transactions post NOTHING. See `matchBank`.
 */
export declare function buildLedger(s: SourceSet, from: string, to: string, currency: string): Ledger;
/**
 * The bank import posts NOTHING, and this is the decision the whole ledger rests on.
 *
 * A bank line and a payment record are not two transactions, they are one transaction seen
 * twice: `invoice_mark_paid` records the receipt, and the same receipt arrives again when
 * the statement is imported. Posting both doubles cash and doubles it silently, because
 * each leg is individually plausible and the trial balance still comes to zero.
 *
 * So cash is posted from the DOCUMENTS, which are the only rows that carry a second leg,
 * and the bank import is used as EVIDENCE: a bank row is matched to a posted cash movement
 * of the same amount, the same direction and a date within `window` days, and the match is
 * written on the cash line as `bank_ref`. What is left over is the interesting part and is
 * reported by `month_close`: a bank debit with nothing to explain it is a payment nobody
 * entered, and a posted cash movement with no bank line behind it either has not cleared or
 * did not happen.
 *
 * A bank row that could match TWO postings is matched to neither. Picking the first would
 * be a coin toss written into a ledger, and the two candidates are exactly the case a human
 * has to look at.
 */
export declare function matchBank(led: Ledger, s: SourceSet, window?: number): {
    matched: number;
    unmatchedBank: number;
    unmatchedCash: number;
};
export interface AccountBalance {
    account: string;
    account_name: string;
    type: AccountType;
    debits_minor: number;
    credits_minor: number;
    /** debits - credits. Positive is a debit balance. */
    balance_minor: number;
    lines: number;
}
export interface TrialBalance {
    currency: string;
    accounts: AccountBalance[];
    debits_minor: number;
    credits_minor: number;
    /** Zero on a ledger that balances. Anything else is a defect in a document, not here. */
    imbalance_minor: number;
    balanced: boolean;
    /** The entries whose own legs do not add up, which is where an imbalance comes from. */
    offenders: Array<{
        entry: string;
        source: string;
        source_id: string;
        date: string;
        difference_minor: number;
    }>;
}
export declare function trialBalance(led: Ledger): TrialBalance;
export declare const money: (minor: number, currency: string) => string;
export declare function filterLines(led: Ledger, f: {
    account?: string;
    source?: string;
    source_id?: string;
    from?: string;
    to?: string;
}): Line[];
/** RFC 4180 CSV: quotes doubled, every field quoted, so a description with a comma survives. */
export declare function toCsv(lines: Line[]): string;
