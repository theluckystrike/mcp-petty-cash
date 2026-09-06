import { formatMoney } from "@theluckystrike/mcp-invoice/lib";
import { paymentRows } from "@theluckystrike/mcp-statement-of-account/lib";
import { buildSchedule, chargeForMonth, monthKey } from "@theluckystrike/mcp-asset-register/lib";
export const CASH = "cash";
export const RECEIVABLES = "receivables";
export const REVENUE = "revenue";
export const VAT_OUTPUT = "vat_output";
export const VAT_INPUT = "vat_input";
export const DEPOSITS_HELD = "deposits_held";
export const FIXED_ASSETS = "fixed_assets";
export const ACCUMULATED_DEPRECIATION = "accumulated_depreciation";
export const DEPRECIATION_EXPENSE = "depreciation_expense";
/** Prefix for the per-category expense accounts, e.g. `expenses:travel`. */
export const EXPENSES = "expenses";
const FIXED = [
    { id: CASH, name: "Cash", type: "asset" },
    { id: RECEIVABLES, name: "Receivables", type: "asset" },
    { id: REVENUE, name: "Revenue", type: "income" },
    { id: VAT_OUTPUT, name: "VAT output", type: "liability" },
    { id: VAT_INPUT, name: "VAT input", type: "asset" },
    { id: DEPOSITS_HELD, name: "Deposits held", type: "liability" },
    { id: FIXED_ASSETS, name: "Fixed assets", type: "asset" },
    { id: ACCUMULATED_DEPRECIATION, name: "Accumulated depreciation", type: "contra-asset" },
    { id: DEPRECIATION_EXPENSE, name: "Depreciation expense", type: "expense" },
];
const UNCATEGORISED = "uncategorised";
export function expenseAccount(category) {
    const c = (category ?? "").trim().toLowerCase().replace(/\s+/g, "-");
    return `${EXPENSES}:${c || UNCATEGORISED}`;
}
export function accountFor(id) {
    const fixed = FIXED.find((a) => a.id === id);
    if (fixed)
        return fixed;
    if (id.startsWith(`${EXPENSES}:`)) {
        return { id, name: `Expenses: ${id.slice(EXPENSES.length + 1).replace(/-/g, " ")}`, type: "expense" };
    }
    return { id, name: id, type: "expense" };
}
/** The normal side of an account: `1` when a debit increases it, `-1` when a credit does. */
export function normalSide(type) {
    return type === "asset" || type === "expense" ? 1 : -1;
}
const inPeriod = (d, from, to) => typeof d === "string" && d >= from && d <= to;
const cur = (c) => (c ?? "").toUpperCase();
/* ------------------------------------------------------------------ currency */
/**
 * Every currency that appears on a document dated inside the period. This is what makes
 * "refuses to mix currencies" a refusal rather than a hope: the caller does not have to
 * know what is in their books for the ledger to notice that two currencies are.
 */
export function currenciesInPeriod(s, from, to) {
    const seen = new Set();
    for (const i of s.invoices.rows)
        if (inPeriod(i.issue_date, from, to) || inPeriod(i.paid_date ?? "", from, to))
            seen.add(cur(i.currency));
    for (const c of s.credit_notes.rows)
        if (inPeriod(c.issue_date, from, to))
            seen.add(cur(c.currency));
    for (const d of s.deposits.rows) {
        if (inPeriod(d.received_date, from, to))
            seen.add(cur(d.currency));
        for (const ap of d.applications)
            if (inPeriod(ap.date, from, to))
                seen.add(cur(d.currency));
        for (const r of d.refunds)
            if (inPeriod(r.date, from, to))
                seen.add(cur(d.currency));
    }
    for (const e of s.expenses.rows)
        if (inPeriod(e.date, from, to))
            seen.add(cur(e.currency));
    for (const b of s.bank.rows)
        if (inPeriod(b.date, from, to))
            seen.add(cur(b.currency));
    for (const a of s.assets.rows)
        if (inPeriod(a.in_service_date, from, to) || a.in_service_date <= to)
            seen.add(cur(a.currency));
    return [...seen].filter(Boolean).sort();
}
/**
 * One ledger is one currency, and there is no exchange rate anywhere in this server, so a
 * single figure over a EUR book and a USD one would be invented. When the period holds two
 * currencies and the caller named neither, the build REFUSES and names both.
 */
export function pickCurrency(seen, asked, fallback) {
    if (asked)
        return cur(asked);
    if (seen.length > 1) {
        throw new Error(`the period holds documents in ${seen.length} currencies (${seen.join(", ")}) and one ledger is one currency. ` +
            `Pass currency to build one of them. Currencies are never added together here: this server holds no exchange rate, ` +
            `so a single trial balance over two currencies would be an invented number that balances.`);
    }
    return seen[0] ?? cur(fallback);
}
/* -------------------------------------------------------------------- months */
/** Every `YYYY-MM` the period touches, in order. */
export function monthsBetween(from, to) {
    const out = [];
    let [y, m] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))];
    const last = to.slice(0, 7);
    for (let guard = 0; guard < 1200; guard += 1) {
        const key = monthKey(y, m);
        if (key > last)
            break;
        out.push(key);
        m += 1;
        if (m > 12) {
            m = 1;
            y += 1;
        }
    }
    return out;
}
function monthEnd(month) {
    const [y, m] = month.split("-").map(Number);
    return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
class Book {
    currency;
    lines = [];
    exceptions = [];
    memos = [];
    constructor(currency) {
        this.currency = currency;
    }
    /**
     * Post one entry. The legs are written EXACTLY as the documents state them; when they do
     * not balance the entry is still posted and the difference is raised as an exception.
     * Forcing a balancing figure in here is the one thing that would make the trial balance
     * useless: it can only find a broken document if it is allowed to be non-zero.
     */
    entry(id, date, source, sourceId, legs) {
        let debit = 0;
        let credit = 0;
        for (const l of legs) {
            if (l.debit === 0 && l.credit === 0)
                continue;
            debit += l.debit;
            credit += l.credit;
            this.lines.push({
                entry: id, date, account: l.account, account_name: accountFor(l.account).name,
                debit_minor: l.debit, credit_minor: l.credit,
                source, source_id: sourceId, description: l.description, currency: this.currency,
            });
        }
        if (debit !== credit) {
            this.exceptions.push({
                kind: "entry-does-not-balance", source, source_id: sourceId, date,
                message: `${sourceId} posts ${debit} minor units of debits against ${credit} of credits, a difference of ${debit - credit}. ` +
                    `The document's own figures do not add up, so nothing was adjusted to hide it.`,
            });
        }
    }
    except(kind, source, sourceId, date, message) {
        this.exceptions.push({ kind, source, source_id: sourceId, date, message });
    }
}
function scheduleFor(a) {
    return buildSchedule({
        scheme: a.scheme, category: a.category, cost_minor: a.cost_minor, currency: a.currency,
        residual_minor: a.residual_minor, purchase_date: a.purchase_date, in_service_date: a.in_service_date,
        method: a.method, life_years: a.life_override, rate_pct: a.rate_override,
        declining_coefficient: a.declining_coefficient,
    });
}
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
export function buildLedger(s, from, to, currency) {
    const C = cur(currency);
    const b = new Book(C);
    const notes = [];
    let excluded = 0;
    const mine = (c) => {
        if (cur(c) === C)
            return true;
        excluded += 1;
        return false;
    };
    /* invoices: revenue, VAT output, receivables */
    for (const inv of s.invoices.rows) {
        if (!inPeriod(inv.issue_date, from, to))
            continue;
        if (!mine(inv.currency))
            continue;
        b.entry(`invoice:${inv.number}`, inv.issue_date, "invoice", inv.number, [
            { account: RECEIVABLES, debit: inv.total_minor, credit: 0, description: `Invoice ${inv.number} to ${inv.client?.name ?? "a client"}` },
            { account: REVENUE, debit: 0, credit: inv.net_minor, description: `Invoice ${inv.number} net` },
            { account: VAT_OUTPUT, debit: 0, credit: inv.tax_minor, description: `Invoice ${inv.number} VAT` },
        ]);
        if ((inv.tax_lines ?? []).length === 0) {
            b.except("invoice-no-vat-rate", "invoice", inv.number, inv.issue_date, `${inv.number} carries no VAT rate at all, so its whole total of ${inv.total_minor} minor units went to revenue and nothing to VAT output. ` +
                `That is right for an exempt or reverse-charge sale and wrong for every other kind, and the ledger cannot tell which from the invoice.`);
        }
    }
    /* credit notes: the same three accounts, reversed */
    for (const cn of s.credit_notes.rows) {
        if (!inPeriod(cn.issue_date, from, to))
            continue;
        if (!mine(cn.currency))
            continue;
        if (cn.total_minor > 0) {
            b.except("credit-note-sign", "billing-docs", cn.id, cn.issue_date, `${cn.id} stores a POSITIVE total of ${cn.total_minor} minor units. servers/billing-docs stores credit notes negative, ` +
                `so this row was written by something else. It was posted as it stands, which reverses its sign in the ledger.`);
        }
        b.entry(`credit-note:${cn.id}`, cn.issue_date, "billing-docs", cn.id, [
            { account: REVENUE, debit: -cn.net_minor, credit: 0, description: `Credit note ${cn.id} against ${cn.invoice_number}` },
            { account: VAT_OUTPUT, debit: -cn.tax_minor, credit: 0, description: `Credit note ${cn.id} VAT` },
            { account: RECEIVABLES, debit: 0, credit: -cn.total_minor, description: `Credit note ${cn.id} to ${cn.client?.name ?? "a client"}` },
        ]);
    }
    /* payments and deposit applications, from the invoice side */
    const knownInvoices = new Set(s.invoices.rows.map((i) => i.number.trim().toLowerCase()));
    for (const inv of s.invoices.rows) {
        if (cur(inv.currency) !== C)
            continue;
        const att = paymentRows(inv, s.deposits.rows);
        if (att.warning) {
            b.except("payment-attribution-disagrees", "invoice", inv.number, inv.paid_date ?? inv.issue_date, att.warning);
        }
        for (const row of att.rows) {
            if (!inPeriod(row.date, from, to))
                continue;
            const amount = -row.amount_minor;
            if (amount === 0)
                continue;
            if (row.kind === "deposit-applied") {
                b.entry(`deposit-applied:${row.reference}:${inv.number}:${row.date}`, row.date, "deposits", row.reference, [
                    { account: DEPOSITS_HELD, debit: amount, credit: 0, description: row.description },
                    { account: RECEIVABLES, debit: 0, credit: amount, description: `${inv.number} settled from deposit ${row.reference}` },
                ]);
            }
            else {
                b.entry(`payment:${inv.number}:${row.date}:${amount}`, row.date, "invoice", inv.number, [
                    { account: CASH, debit: amount, credit: 0, description: row.description },
                    { account: RECEIVABLES, debit: 0, credit: amount, description: `${inv.number} paid` },
                ]);
            }
        }
    }
    /* deposits received and refunded */
    for (const d of s.deposits.rows) {
        if (cur(d.currency) !== C) {
            excluded += 1;
            continue;
        }
        if (inPeriod(d.received_date, from, to)) {
            b.entry(`deposit:${d.id}`, d.received_date, "deposits", d.id, [
                { account: CASH, debit: d.amount_minor, credit: 0, description: `Deposit ${d.id} received from ${d.client?.name ?? "a client"}` },
                { account: DEPOSITS_HELD, debit: 0, credit: d.amount_minor, description: `Deposit ${d.id} held` },
            ]);
        }
        for (const r of d.refunds) {
            if (!inPeriod(r.date, from, to))
                continue;
            b.entry(`deposit-refund:${d.id}:${r.date}:${r.amount_minor}`, r.date, "deposits", d.id, [
                { account: DEPOSITS_HELD, debit: r.amount_minor, credit: 0, description: `Deposit ${d.id} refunded by ${r.method}` },
                { account: CASH, debit: 0, credit: r.amount_minor, description: `Deposit ${d.id} refunded` },
            ]);
        }
        for (const ap of d.applications) {
            if (!inPeriod(ap.date, from, to))
                continue;
            if (knownInvoices.has(ap.invoice_number.trim().toLowerCase()))
                continue;
            b.except("deposit-applied-to-unknown-invoice", "deposits", d.id, ap.date, `${d.id} applies ${ap.amount_minor} minor units to ${ap.invoice_number}, which is not in the invoice ledger. ` +
                `Nothing was posted for it, so deposits held is ${ap.amount_minor} minor units too high and receivables untouched. ` +
                `Posting it against an invoice that does not exist would have settled a debt nobody owes.`);
        }
    }
    /* expenses: the amount is VAT-inclusive, so the VAT comes OUT of it */
    for (const e of s.expenses.rows) {
        if (!inPeriod(e.date, from, to))
            continue;
        if (!mine(e.currency))
            continue;
        const gross = e.amount_minor;
        const rate = typeof e.vat_rate === "number" && e.vat_rate > 0 ? e.vat_rate : 0;
        const vat = rate ? Math.round((gross * rate) / (100 + rate)) : 0;
        const account = expenseAccount(e.category);
        b.entry(`expense:${e.id}`, e.date, "expense-tracker", e.id, [
            { account, debit: gross - vat, credit: 0, description: `${e.merchant ? `${e.merchant}: ` : ""}${e.category ?? "uncategorised"}` },
            { account: VAT_INPUT, debit: vat, credit: 0, description: `VAT on ${e.id} at ${rate} percent` },
            { account: CASH, debit: 0, credit: gross, description: `Paid ${e.merchant ?? e.category ?? e.id}` },
        ]);
    }
    /* fixed assets and their depreciation */
    const months = monthsBetween(from, to);
    for (const a of s.assets.rows) {
        if (cur(a.currency) !== C) {
            excluded += 1;
            continue;
        }
        if (inPeriod(a.in_service_date, from, to)) {
            b.entry(`asset:${a.id}`, a.in_service_date, "asset-register", a.id, [
                { account: FIXED_ASSETS, debit: a.cost_minor, credit: 0, description: `${a.name} entered service` },
                { account: CASH, debit: 0, credit: a.cost_minor, description: `Paid for ${a.name}` },
            ]);
        }
        let schedule;
        try {
            schedule = scheduleFor(a);
        }
        catch (err) {
            b.except("entry-does-not-balance", "asset-register", a.id, a.in_service_date, `${a.id} has no depreciation schedule (${err.message}), so no charge was posted for it.`);
            continue;
        }
        const stop = a.disposal ? a.disposal.date.slice(0, 7) : undefined;
        for (const m of months) {
            if (stop && m > stop)
                break;
            const amount = chargeForMonth(schedule, m);
            if (!amount)
                continue;
            const date = monthEnd(m) > to ? to : monthEnd(m);
            b.entry(`depreciation:${a.id}:${m}`, date, "asset-register", a.id, [
                { account: DEPRECIATION_EXPENSE, debit: amount, credit: 0, description: `${a.name} depreciation for ${m}` },
                { account: ACCUMULATED_DEPRECIATION, debit: 0, credit: amount, description: `${a.name} accumulated to ${m}` },
            ]);
        }
        if (a.disposal && inPeriod(a.disposal.date, from, to)) {
            b.except("asset-disposal-not-posted", "asset-register", a.id, a.disposal.date, `${a.id} was disposed of in this period for ${a.disposal.proceeds_minor} minor units, with a net book value of ${a.disposal.nbv_minor}. ` +
                `The removal of cost and accumulated depreciation is NOT posted here: the disposal proceeds land in the bank import and in the expense ` +
                `ledger in ways only a human can attribute, so fixed assets and accumulated depreciation both still carry this asset.`);
        }
    }
    /* purchase orders: a MEMO, never posted */
    for (const po of s.purchase_orders.rows) {
        if (!inPeriod(po.issue_date, from, to))
            continue;
        if (cur(po.currency) !== C) {
            excluded += 1;
            continue;
        }
        if (po.status === "received")
            continue;
        b.memos.push({
            kind: "purchase-commitment", source: "billing-docs", source_id: po.id, date: po.issue_date,
            amount_minor: po.total_minor,
            description: `${po.id} to ${po.supplier?.name ?? "a supplier"}, ${po.status.replace(/_/g, " ")}`,
        });
    }
    b.lines.sort((x, y) => x.date.localeCompare(y.date) || x.entry.localeCompare(y.entry) || x.account.localeCompare(y.account));
    if (from.slice(8) !== "01" && months.length) {
        notes.push(`The period starts on ${from}, which is not the first of a month. Depreciation is charged by whole months, so ${months[0]} carries its whole charge.`);
    }
    return {
        from, to, currency: C, lines: b.lines, exceptions: b.exceptions, memos: b.memos,
        currencies_seen: currenciesInPeriod(s, from, to), excluded_rows: excluded, notes,
    };
}
/* ------------------------------------------------------------ bank matching */
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
export function matchBank(led, s, window = 3) {
    const cashLines = led.lines.filter((l) => l.account === CASH);
    const claimed = new Set();
    let matched = 0;
    let unmatchedBank = 0;
    const rows = s.bank.rows
        .filter((r) => inPeriod(r.date, led.from, led.to) && cur(r.currency) === led.currency)
        .sort((a, x) => a.date.localeCompare(x.date) || a.id.localeCompare(x.id));
    for (const r of rows) {
        const into = r.amount_minor > 0;
        const amount = Math.abs(r.amount_minor);
        const candidates = cashLines.filter((l) => !claimed.has(l) &&
            (into ? l.debit_minor === amount : l.credit_minor === amount) &&
            Math.abs(days(l.date) - days(r.date)) <= window);
        if (candidates.length === 1) {
            claimed.add(candidates[0]);
            candidates[0].bank_ref = r.id;
            matched += 1;
            continue;
        }
        unmatchedBank += 1;
        if (candidates.length > 1) {
            led.exceptions.push({
                kind: "bank-row-ambiguous", source: "bank-statement", source_id: r.id, date: r.date,
                message: `${r.id} (${r.description}) for ${r.amount_minor} minor units matches ${candidates.length} posted cash movements ` +
                    `(${candidates.map((c) => c.source_id).join(", ")}) and was matched to none of them. One bank line is one movement; ` +
                    `picking the first would be a guess written into a ledger.`,
            });
            continue;
        }
        led.exceptions.push({
            kind: into ? "bank-credit-unexplained" : "bank-debit-unexplained",
            source: "bank-statement", source_id: r.id, date: r.date,
            message: into
                ? `${r.id} (${r.description}) received ${amount} minor units with no invoice payment and no deposit to explain it. ` +
                    `Nothing was posted: the ledger cannot know what was sold.`
                : `${r.id} (${r.description}) paid out ${amount} minor units with no expense, no refund and no asset behind it. ` +
                    `Nothing was posted, so cash in this ledger is higher than the bank says by that amount.`,
        });
    }
    const unmatchedCash = cashLines.filter((l) => !l.bank_ref).length;
    if (s.bank.ok && rows.length) {
        for (const l of cashLines.filter((x) => !x.bank_ref)) {
            led.exceptions.push({
                kind: "cash-without-bank-evidence", source: l.source, source_id: l.source_id, date: l.date,
                message: `${l.source_id} moves ${l.debit_minor || l.credit_minor} minor units of cash on ${l.date} and no bank line within ${window} days matches it. ` +
                    `Either it has not cleared, or it was recorded and never happened.`,
            });
        }
    }
    return { matched, unmatchedBank, unmatchedCash };
}
const DAY = 86400000;
function days(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    return Math.floor(Date.UTC(y, (m || 1) - 1, d || 1) / DAY);
}
export function trialBalance(led) {
    const map = new Map();
    for (const l of led.lines) {
        const acc = map.get(l.account) ?? {
            account: l.account, account_name: l.account_name, type: accountFor(l.account).type,
            debits_minor: 0, credits_minor: 0, balance_minor: 0, lines: 0,
        };
        acc.debits_minor += l.debit_minor;
        acc.credits_minor += l.credit_minor;
        acc.balance_minor = acc.debits_minor - acc.credits_minor;
        acc.lines += 1;
        map.set(l.account, acc);
    }
    const accounts = [...map.values()].sort((a, b) => a.account.localeCompare(b.account));
    const debits = accounts.reduce((a, x) => a + x.debits_minor, 0);
    const credits = accounts.reduce((a, x) => a + x.credits_minor, 0);
    const perEntry = new Map();
    for (const l of led.lines) {
        const e = perEntry.get(l.entry) ?? { entry: l.entry, source: l.source, source_id: l.source_id, date: l.date, difference_minor: 0 };
        e.difference_minor += l.debit_minor - l.credit_minor;
        perEntry.set(l.entry, e);
    }
    return {
        currency: led.currency, accounts,
        debits_minor: debits, credits_minor: credits,
        imbalance_minor: debits - credits,
        balanced: debits === credits,
        offenders: [...perEntry.values()].filter((e) => e.difference_minor !== 0)
            .sort((a, b) => a.date.localeCompare(b.date)),
    };
}
export const money = (minor, currency) => formatMoney(minor, currency);
/* ------------------------------------------------------------------- filters */
export function filterLines(led, f) {
    const account = f.account?.trim().toLowerCase();
    const source = f.source?.trim().toLowerCase();
    const id = f.source_id?.trim().toLowerCase();
    return led.lines.filter((l) => {
        if (account && l.account.toLowerCase() !== account && !l.account.toLowerCase().startsWith(`${account}:`))
            return false;
        if (source && l.source.toLowerCase() !== source)
            return false;
        if (id && l.source_id.toLowerCase() !== id)
            return false;
        if (f.from && l.date < f.from)
            return false;
        if (f.to && l.date > f.to)
            return false;
        return true;
    });
}
/** RFC 4180 CSV: quotes doubled, every field quoted, so a description with a comma survives. */
export function toCsv(lines) {
    const head = ["date", "entry", "account", "account_name", "debit_minor", "credit_minor", "currency", "source", "source_id", "bank_ref", "description"];
    const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = lines.map((l) => [
        l.date, l.entry, l.account, l.account_name, l.debit_minor, l.credit_minor, l.currency, l.source, l.source_id, l.bank_ref ?? "", l.description,
    ].map(cell).join(","));
    return [head.map(cell).join(","), ...rows].join("\n") + "\n";
}
