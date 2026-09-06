import { type Invoice } from "@theluckystrike/mcp-invoice/lib";
import type { CreditNote } from "@theluckystrike/mcp-billing-docs/lib";
import { type Deposit } from "@theluckystrike/mcp-deposits/lib";
import type { SourceSet } from "./sources.js";
/**
 * The statement arithmetic. No I/O, no licensing, no MCP: everything here is a pure
 * function of the three stores' rows, so a unit test can hand it a worked month and
 * assert the closing balance against the invoices, credit notes and deposits that
 * produced it.
 */
export type MovementKind = "invoice" | "payment" | "deposit-applied" | "credit-note";
export interface Movement {
    date: string;
    kind: MovementKind;
    /** The document this row came from: an invoice number, a `CN-` id or a `DEP-` id. */
    reference: string;
    description: string;
    /** Signed, in minor units. POSITIVE increases what the client owes. */
    amount_minor: number;
}
export interface Party {
    name: string;
    address?: string;
    email?: string;
    vat_id?: string;
}
export interface ClientScope {
    id?: string;
    name: string;
    party: Party;
    invoices: Invoice[];
    credit_notes: CreditNote[];
    deposits: Deposit[];
    /** Currencies this client has any document in, sorted. */
    currencies: string[];
}
/**
 * A client is matched by invoice-store id, then by exact document name, then by a name
 * CONTAINING the text, in that order, and an ambiguous partial is refused with the
 * candidates rather than resolved to the first hit. A statement is a demand for money;
 * sending one client another client's balance is the worst failure this server has.
 */
export declare function resolveClient(s: SourceSet, ref: string): ClientScope;
/**
 * One statement is in ONE currency. A client billed in EUR and in USD has two balances
 * and adding them would be a made-up number: this server holds no exchange rate, so the
 * currency is asked for rather than guessed when there is more than one.
 */
export declare function pickCurrency(scope: ClientScope, stated: string | undefined): string;
export interface PaymentAttribution {
    rows: Movement[];
    /** Named when the attribution had to be discarded or filled in. */
    warning?: string;
}
/**
 * Turn one invoice's `paid_minor` into dated payment rows.
 *
 * `paid_minor` is the AUTHORITY and `payments[]` is only the attribution, because the two
 * do not have to agree and on a real machine they usually do not:
 *
 *  - `invoice_mark_paid` appends a `payments[]` row AND raises `paid_minor`.
 *  - `deposit_apply` (servers/deposits) raises `paid_minor` and appends NOTHING to
 *    `payments[]`; the movement lives on the deposit as a `DepositApplication`.
 *  - an invoice created before `payments[]` existed carries `paid_minor` and a single
 *    `paid_date`, and no rows at all.
 *
 * So the rows are assembled as: every `payments[]` row, plus every deposit application
 * naming this invoice, plus one residual row at `paid_date` for whatever `paid_minor`
 * still exceeds those two. The rows therefore sum to `paid_minor` exactly, which is what
 * makes the closing balance reconcile to `total_minor - paid_minor` per invoice.
 *
 * When the attribution sums to MORE than `paid_minor` the invoice and the deposit book
 * disagree about money. Nothing is scaled and nothing is dropped silently: the whole
 * attribution is discarded, a single row for `paid_minor` is used instead, and the
 * disagreement is returned as a warning naming the invoice and the difference.
 */
export declare function paymentRows(inv: Invoice, deposits: Deposit[]): PaymentAttribution;
/** Every movement on this client's account in one currency, in date order, from the start. */
export declare function allMovements(scope: ClientScope, currency: string): {
    rows: Movement[];
    warnings: string[];
};
export interface Statement {
    client: Party;
    client_id?: string;
    currency: string;
    from: string;
    to: string;
    opening_minor: number;
    rows: Movement[];
    invoiced_minor: number;
    paid_minor: number;
    deposits_applied_minor: number;
    credited_minor: number;
    closing_minor: number;
    /** Deposit money still held for this client in this currency: a memo, never in the balance. */
    held_deposit_minor: number;
    warnings: string[];
}
/**
 * Build one client's statement for a period.
 *
 * The opening balance is the sum of every signed movement dated strictly BEFORE `from`.
 * The closing balance is the opening balance plus every signed movement in the period.
 * The identity therefore holds by construction rather than by a second calculation that
 * could disagree with the rows printed above it.
 *
 * `deposits_applied_minor` is a SUBSET of the money that left the account, not an extra
 * credit: `deposit_apply` writes the money onto the invoice as `paid_minor`, so counting
 * the deposit application again would pay the invoice twice. It is broken out because a
 * client reading a statement wants to see that their deposit was used, but the ledger
 * only ever moves it once.
 */
export declare function buildStatement(scope: ClientScope, currency: string, from: string, to: string): Statement;
export declare const BUCKETS: readonly ["0-30", "31-60", "61-90", "over 90"];
export type Bucket = (typeof BUCKETS)[number];
export declare function bucketOf(daysOverdue: number): Bucket;
export interface AgedInvoice {
    number: string;
    client: string;
    currency: string;
    issue_date: string;
    due_date: string;
    total_minor: number;
    paid_minor: number;
    credited_minor: number;
    open_minor: number;
    days_overdue: number;
    bucket: Bucket | "not yet due";
}
export interface AgingRow {
    currency: string;
    buckets: Record<Bucket, number>;
    not_yet_due_minor: number;
    overdue_minor: number;
    outstanding_minor: number;
    /** Credit that exceeds the invoice it was issued against, so it reduces nothing. */
    unapplied_credit_minor: number;
    invoices: AgedInvoice[];
}
/**
 * Age one client's open invoices as at a date.
 *
 * Every figure is taken AS AT `as_of`, not as at now: an invoice issued after the date is
 * not on the books yet, a payment made after it has not happened yet, and a credit note
 * issued after it has not been given yet. Aging that mixes a historic due date with a
 * present-day paid_minor is the standard way to produce a bucket that cannot be
 * reproduced next month.
 *
 * An invoice is overdue only once `as_of` is PAST its due date: due today is not overdue,
 * so day zero sits in "not yet due" and the "0-30" bucket holds days one to thirty.
 *
 * Credit is applied to the invoice it names, never beyond it. A credit note larger than
 * the invoice it reverses cannot make the invoice owe a negative amount, so the open
 * balance floors at zero and the excess is reported separately as unapplied credit rather
 * than quietly cancelling another invoice the client never agreed it against.
 */
export declare function ageClient(scope: ClientScope, currency: string, asOf: string): AgingRow;
/** The oldest overdue invoice on a set of aged rows, or undefined when nothing is overdue. */
export declare function oldestOverdue(rows: AgedInvoice[]): AgedInvoice | undefined;
