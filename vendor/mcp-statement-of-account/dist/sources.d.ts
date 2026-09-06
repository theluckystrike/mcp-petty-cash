import { type Business, type Client, type Invoice } from "@theluckystrike/mcp-invoice/lib";
import { type CreditNote } from "@theluckystrike/mcp-billing-docs/lib";
import { type Deposit } from "@theluckystrike/mcp-deposits/lib";
/**
 * The three sibling stores, read READ-ONLY and BEST EFFORT.
 *
 * A statement of account is assembled from books this server does not own. Two rules
 * follow, and both are load-bearing:
 *
 * 1. Nothing here writes. Not a payment, not a status, not a counter. `deposit_apply`
 *    already writes the payment onto the invoice, `credit_note_issue` already stores the
 *    credit; a statement that also wrote would double the money in the books it is
 *    supposed to be reporting on.
 *
 * 2. A sibling store that is missing, empty or QUARANTINED is reported, never fatal. The
 *    common case on a real machine is that the user runs mcp-invoice and has never
 *    installed mcp-deposits: their statement is still correct, it simply has no deposit
 *    line. A corrupt store is different -- there is money on disk that could not be read
 *    -- so the failure is carried into every answer as a named source error rather than
 *    silently read as zero. The one thing never done is treating an unreadable file as
 *    an empty one, because that turns a balance that could not be computed into a
 *    balance of nothing owed.
 *
 * The invoice store is the exception to "never fatal": with no invoices there is no
 * statement at all, so a corrupt INVOICE store refuses the tool by name. A corrupt
 * credit note or deposit store degrades the statement and says so on every figure.
 */
export interface Source<T> {
    /** What was read. Empty when the store is missing, empty or unreadable. */
    rows: T[];
    /** Present only when the store exists on disk and could not be read. */
    error?: string;
    /** True when the store was read successfully, whether or not it had rows. */
    ok: boolean;
}
export interface SourceSet {
    invoices: Source<Invoice>;
    credit_notes: Source<CreditNote>;
    deposits: Source<Deposit>;
    clients: Source<Client>;
}
export declare function readSources(): SourceSet;
/** One line per store, for the `sources` field every answer carries. */
export declare function sourceReport(s: SourceSet): Array<{
    store: string;
    read: boolean;
    rows: number;
    error?: string;
}>;
/**
 * The sentence that goes into an answer when a sibling store could not be read. It names
 * the store and says which figure is therefore incomplete, because a statement short one
 * credit note is not wrong by a rounding error, it is wrong by the credit note.
 */
export declare function degradedNotes(s: SourceSet): string[];
/** Refusal text for the one store a statement cannot be built without. */
export declare function invoicesUnreadable(s: SourceSet, toolName: string): string;
export declare const NO_BUSINESS_NOTE: string;
/** Never throws: an unreadable business profile degrades to the placeholder issuer. */
export declare function issuer(): Business;
export declare function businessMissing(): boolean;
/** Still-held deposit money per currency for one client, a memo line on the statement. */
export declare function heldFor(deposits: Deposit[], currency: string): number;
