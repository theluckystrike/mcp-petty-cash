#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLicenseGate, withFileLock } from "@theluckystrike/mcp-license";
import { isIsoDate, today } from "@theluckystrike/mcp-quotes/lib";
import { z } from "zod";
import { VERSION } from "./version.js";
import { dataDir, findClose, findPeriod, getCloses, getPeriods, lockPath, periodId, periodKey, setCloses, setPeriods, } from "./store.js";
import { degradedNotes, readSources, sourceReport } from "./sources.js";
import { accountFor, buildLedger, currenciesInPeriod, filterLines, matchBank, money, pickCurrency, toCsv, trialBalance, } from "./ledger.js";
/**
 * Free tier: THREE distinct periods a calendar month, and the trial balance with no limit
 * at all.
 *
 * The trial balance is free because it is the only question this server exists to answer:
 * do the books add up. A free tier that hides the answer and sells it back is a demo, and
 * a bookkeeper who cannot check the sum has no reason to trust anything else here. The
 * meter is on the PERIOD, the unit of work, and a period already in the register is
 * rebuilt free forever, so asking about September twice costs what asking once cost.
 */
const FREE_PERIODS_PER_MONTH = 3;
const MAX_ROWS = 5000;
const MAX_NAME = 200;
const gate = createLicenseGate({ product: "cash-book" });
const ok = (text) => ({ content: [{ type: "text", text }] });
const fail = (text) => ({ content: [{ type: "text", text: `Error: ${text}` }], isError: true });
const json = (v) => ok(JSON.stringify(v, null, 2));
const str = (field, max) => z.string().max(max, `${field} must be ${max} characters or fewer`);
/** Only this server's own register is written, so there is one lock and it is this one. */
function locked(fn) {
    return withFileLock(lockPath(), fn, { timeoutMs: 20000 });
}
/** Normalise a date argument before it is read or compared: whitespace only, never a shape. */
function normDate(value) { return String(value ?? "").trim(); }
function checkDate(value, field) {
    if (!isIsoDate(value))
        throw new Error(`cannot read a date: ${field} "${value}" is not a real date in YYYY-MM-DD form. Nothing was written.`);
    return value;
}
function checkPeriod(from, to) {
    if (to < from)
        throw new Error(`the period runs backwards: from ${from} is after to ${to}. Nothing was written.`);
}
function monthEnd(month) {
    const [y, m] = month.split("-").map(Number);
    return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
function checkMonth(value) {
    const m = value.trim();
    if (!/^\d{4}-\d{2}$/.test(m) || Number(m.slice(5)) < 1 || Number(m.slice(5)) > 12) {
        throw new Error(`month "${value}" is not a month in YYYY-MM form. Nothing was written.`);
    }
    return { month: m, from: `${m}-01`, to: monthEnd(m) };
}
/* --------------------------------------------------------------- assembly */
/**
 * Read every sibling store once and derive the ledger. Nothing is cached between calls:
 * the sibling books move under this server all the time, and a ledger that answers from a
 * cache is a ledger that answers about a month that no longer exists.
 */
function derive(rawFrom, rawTo, currency) {
    const from = normDate(rawFrom);
    const to = normDate(rawTo);
    checkDate(from, "from");
    checkDate(to, "to");
    checkPeriod(from, to);
    const s = readSources();
    const seen = currenciesInPeriod(s, from, to);
    const chosen = pickCurrency(seen, currency, "EUR");
    const led = buildLedger(s, from, to, chosen);
    const bank = matchBank(led, s);
    return { s, led, bank };
}
function ledgerHead(led, s, bank) {
    const tb = trialBalance(led);
    return {
        period: { from: led.from, to: led.to },
        currency: led.currency,
        lines: led.lines.length,
        debits: money(tb.debits_minor, led.currency),
        debits_minor: tb.debits_minor,
        credits: money(tb.credits_minor, led.currency),
        credits_minor: tb.credits_minor,
        balanced: tb.balanced,
        imbalance_minor: tb.imbalance_minor,
        currencies_in_period: led.currencies_seen,
        rows_in_other_currencies: led.excluded_rows,
        bank_reconciliation: {
            matched: bank.matched,
            bank_rows_unmatched: bank.unmatchedBank,
            posted_cash_without_bank_evidence: bank.unmatchedCash,
        },
        exceptions: led.exceptions.length,
        memos: led.memos.length,
        sources: sourceReport(s),
        notes: [...degradedNotes(s), ...led.notes],
    };
}
function lineJson(l) {
    return {
        date: l.date, entry: l.entry, account: l.account, account_name: l.account_name,
        debit: money(l.debit_minor, l.currency), debit_minor: l.debit_minor,
        credit: money(l.credit_minor, l.currency), credit_minor: l.credit_minor,
        source: l.source, source_id: l.source_id, description: l.description,
        bank_ref: l.bank_ref,
    };
}
const BASIS = "Every line is derived from a document in another server's store and carries that server, that document's id and that document's date. " +
    "Nothing is entered here and nothing is written back. Cash is posted from the documents; the bank import is evidence, never a posting, " +
    "because a bank line and a payment record are one movement seen twice and posting both doubles cash silently.";
/* ---------------------------------------------------------- the free meter */
function capRefusal(count, month, built, toolName) {
    const names = built.map((r) => periodId(r.from, r.to, r.currency)).join(", ");
    return `the free tier builds ${FREE_PERIODS_PER_MONTH} periods a calendar month and ${count} have already been built in ${month}` +
        `${names ? ` (${names})` : ""}. ` +
        `trial_balance stays free and unlimited, and any period already in the register can be rebuilt as often as you like at no cost. ` +
        `A period you no longer need can be removed with period_delete, which counts from the register and so gives its slot back this month. ` +
        `Nothing was written. ` + gate.upgradeText("unlimited ledger periods", toolName);
}
/** The figures a build would store. Two builds that produce these are the same build. */
function figuresOf(led) {
    const tb = trialBalance(led);
    return {
        lines: led.lines.length, debits_minor: tb.debits_minor, credits_minor: tb.credits_minor,
        imbalance_minor: tb.imbalance_minor,
    };
}
/**
 * A rebuild that would write back exactly what is already stored is refused rather than
 * accepted silently: round 19 (docs/DIST_R19_RESULT.md, finding 3) measured that a tool
 * which takes the same record twice and answers as if something happened teaches a caller
 * to repeat it. The register is the free tier's unit, so the refusal names the row, says
 * nothing was written and names the tool that removes it.
 *
 * It is the FIGURES that are compared, not just the dates: the sibling books move under
 * this server, so a period whose ledger has changed is still rebuilt and the row updated.
 * Only the identical rebuild, the one with nothing to write, is turned away.
 */
function duplicateRefusal(rec) {
    const id = periodId(rec.from, rec.to, rec.currency);
    return `the period ${id} is already built and this rebuild is identical to it: ` +
        `${rec.lines} lines, ${rec.debits_minor} minor units of debits and ${rec.credits_minor} of credits, unchanged since ${rec.updated}. ` +
        `Nothing was written and no free period was used, so the register still holds one row for ${id}. ` +
        `Read it with trial_balance or ledger_lines, both free and unlimited, or remove it with period_delete ` +
        `(from ${rec.from}, to ${rec.to}, currency ${rec.currency}). A rebuild is only refused while it would change nothing: ` +
        `once a sibling store moves, the same call rebuilds the period and updates the row.`;
}
/**
 * Register the period, or refuse it. A period already in the register is UPDATED and never
 * counted again. The check and the write are one critical section, so two processes racing
 * the third free period of the month cannot both pass it.
 */
async function register(led, toolName) {
    const figures = figuresOf(led);
    return await locked(() => {
        const list = getPeriods();
        const existing = findPeriod(list, periodKey(led.from, led.to, led.currency));
        const now = new Date().toISOString();
        if (existing) {
            const same = Object.keys(figures).every((k) => existing[k] === figures[k]);
            if (same)
                throw new Error(duplicateRefusal(existing));
            Object.assign(existing, figures, { updated: now });
            setPeriods(list);
            return existing;
        }
        const month = now.slice(0, 7);
        if (!gate.isPro()) {
            const thisMonth = list.filter((r) => r.built_month === month);
            if (thisMonth.length >= FREE_PERIODS_PER_MONTH)
                throw new Error(capRefusal(thisMonth.length, month, thisMonth, toolName));
        }
        const rec = {
            from: led.from, to: led.to, currency: led.currency, ...figures,
            built_month: month, built: now, updated: now,
        };
        list.push(rec);
        setPeriods(list);
        return rec;
    });
}
function requirePro(feature, toolName, note) {
    if (!gate.isPro())
        throw new Error(`${feature} is Pro. Nothing was written. ${note ? note + " " : ""}${gate.upgradeText(feature, toolName)}`);
}
/**
 * ledger_lines already returns every leg free and unlimited, bank_ref included: round 29
 * (data/user_value_r29.json, prompt 6) measured a model refused this tool correctly, then
 * hand-built a substitute CSV from ledger_lines and dropped bank_ref anyway. The gate is on
 * the CSV's shape, not on the bank evidence, so the refusal says that plainly.
 */
const LEDGER_EXPORT_CSV_NOTE = "ledger_lines returns every leg free, including the bank_ref that evidences each cash line; " +
    "the export only adds the RFC 4180 column layout and a file, not new data. Call ledger_lines and relay it " +
    "rather than reassembling a CSV by hand: a hand-built copy is not this export's schema.";
/* ------------------------------------------------------------------- server */
const server = new McpServer({ name: "mcp-cash-book", version: VERSION }, { capabilities: { tools: {}, resources: {}, prompts: {} } });
const fromArg = str("from", 10).describe("First day of the period, YYYY-MM-DD");
const toArg = str("to", 10).describe("Last day of the period, YYYY-MM-DD, inclusive");
const currencyArg = z.string().regex(/^[A-Za-z]{3}$/, "currency must be a 3-letter ISO code such as EUR").optional()
    .describe("Needed when the period holds documents in more than one currency. Currencies are never added together");
server.registerTool("ledger_build", {
    title: "Build the ledger for a period",
    description: "Derive the double-entry ledger for one period in one currency from the invoice, credit note, deposit, expense, bank and asset stores. Every line names its source server, source id and date. Nothing is written back.",
    inputSchema: { from: fromArg, to: toArg, currency: currencyArg },
}, async (a) => {
    try {
        const { s, led, bank } = derive(a.from, a.to, a.currency);
        const rec = await register(led, "ledger_build");
        return json({
            built: { from: rec.from, to: rec.to, currency: rec.currency, first_built: rec.built, updated: rec.updated },
            ...ledgerHead(led, s, bank),
            accounts: trialBalance(led).accounts.map((x) => ({
                account: x.account, account_name: x.account_name, lines: x.lines,
                balance: money(x.balance_minor, led.currency), balance_minor: x.balance_minor,
            })),
            purchase_commitments: led.memos.map((m) => ({
                source_id: m.source_id, date: m.date, amount: money(m.amount_minor, led.currency),
                amount_minor: m.amount_minor, description: m.description,
                note: "A memo. An order is a commitment, not a transaction: nothing was delivered and nothing is owed, so no debit and no credit exists for it.",
            })),
            basis: BASIS,
        });
    }
    catch (e) {
        return fail(e.message);
    }
});
/**
 * What stands on a built period. The register is not read to compute a balance, so the
 * only thing downstream of a period row is the close snapshot: `month_close` writes a
 * trial balance for a month, and a period whose days that month covers is the work that
 * snapshot was taken over. Nothing is posted, exported or carried forward from a period:
 * `ledger_export_csv` writes no file and this ledger opens at nothing, so no later period
 * carries a figure out of an earlier one.
 */
function dependentsOf(rec, closes) {
    return closes
        .filter((c) => c.currency.toUpperCase() === rec.currency.toUpperCase())
        .filter((c) => !(monthEnd(c.month) < rec.from || `${c.month}-01` > rec.to))
        .map((c) => `the month ${c.month} was closed on ${c.closed} in ${c.currency} and its trial balance snapshot ` +
        `(${c.debits_minor} minor units of debits over ${Object.keys(c.balances).length} accounts) covers days inside this period`);
}
server.registerTool("period_delete", {
    title: "Delete a built period",
    description: "Delete one built period from the register and give its free-tier slot back. Refused when a closed month's snapshot covers the period, and that month is named. No sibling book is touched.",
    inputSchema: {
        from: fromArg, to: toArg,
        currency: z.string().regex(/^[A-Za-z]{3}$/, "currency must be a 3-letter ISO code such as EUR").optional()
            .describe("Needed only when the same date range was built in more than one currency"),
    },
}, async (a) => {
    try {
        const from = checkDate(normDate(a.from), "from");
        const to = checkDate(normDate(a.to), "to");
        checkPeriod(from, to);
        const out = await locked(() => {
            const list = getPeriods();
            const matches = a.currency
                ? list.filter((p) => periodKey(p.from, p.to, p.currency) === periodKey(from, to, a.currency))
                : list.filter((p) => p.from === from && p.to === to);
            if (matches.length === 0) {
                const held = list.map((p) => periodId(p.from, p.to, p.currency));
                throw new Error(`no period ${periodId(from, to, a.currency ?? "any")} is in the register, so there is nothing to delete and nothing was written. ` +
                    (held.length ? `The register holds ${held.length}: ${held.join(", ")}.` : "The register is empty."));
            }
            if (matches.length > 1) {
                const seen = matches.map((p) => p.currency.toUpperCase()).join(", ");
                throw new Error(`the range ${from}..${to} is built in ${matches.length} currencies (${seen}) and one call deletes one period. ` +
                    `Pass currency to name which. Nothing was deleted.`);
            }
            const rec = matches[0];
            const id = periodId(rec.from, rec.to, rec.currency);
            const deps = dependentsOf(rec, getCloses());
            if (deps.length) {
                throw new Error(`${id} has ${deps.length} dependent${deps.length === 1 ? "" : "s"} and was not deleted: ${deps.join("; ")}. ` +
                    `Nothing was written. The snapshot is the record of what the books said at that close, so the period it was taken over stays in the register.`);
            }
            list.splice(list.indexOf(rec), 1);
            setPeriods(list);
            const month = new Date().toISOString().slice(0, 7);
            const used = list.filter((r) => r.built_month === month).length;
            return { rec, id, month, used, remaining: list.length };
        });
        return json({
            deleted: {
                period: out.id, from: out.rec.from, to: out.rec.to, currency: out.rec.currency,
                first_built: out.rec.built, last_updated: out.rec.updated, lines: out.rec.lines,
            },
            periods_in_register: out.remaining,
            free_tier: gate.isPro()
                ? { tier: "pro", metered: false }
                : {
                    tier: "free", month: out.month, periods_built_this_month: out.used,
                    periods_left_this_month: Math.max(0, FREE_PERIODS_PER_MONTH - out.used),
                },
            basis: "The free tier counts the rows in the register, not calls made, so this delete gave the slot back. " +
                "Only this server's own register changed: no invoice, credit note, deposit, expense, bank row or asset was touched, " +
                "and the ledger for these dates can be derived again at any time with trial_balance or ledger_lines, both free and unlimited.",
        });
    }
    catch (e) {
        return fail(e.message);
    }
});
server.registerTool("trial_balance", {
    title: "Prove the ledger balances",
    description: "Total the debits and the credits for a period and prove they are equal to the minor unit. When they are not, name the entries whose own legs do not add up and the source document behind each. Free and unlimited.",
    inputSchema: { from: fromArg, to: toArg, currency: currencyArg },
}, async (a) => {
    try {
        const { s, led, bank } = derive(a.from, a.to, a.currency);
        const tb = trialBalance(led);
        return json({
            period: { from: led.from, to: led.to }, currency: led.currency,
            balanced: tb.balanced,
            debits: money(tb.debits_minor, led.currency), debits_minor: tb.debits_minor,
            credits: money(tb.credits_minor, led.currency), credits_minor: tb.credits_minor,
            imbalance: money(tb.imbalance_minor, led.currency), imbalance_minor: tb.imbalance_minor,
            accounts: tb.accounts.map((x) => ({
                account: x.account, account_name: x.account_name, type: x.type, lines: x.lines,
                debits: money(x.debits_minor, led.currency), debits_minor: x.debits_minor,
                credits: money(x.credits_minor, led.currency), credits_minor: x.credits_minor,
                balance: money(x.balance_minor, led.currency), balance_minor: x.balance_minor,
            })),
            offenders: tb.offenders.map((o) => ({
                entry: o.entry, source: o.source, source_id: o.source_id, date: o.date,
                difference: money(o.difference_minor, led.currency), difference_minor: o.difference_minor,
            })),
            verdict: tb.balanced
                ? "The debits equal the credits to the minor unit."
                : `The ledger is out by ${tb.imbalance_minor} minor units. Every offending entry is named above with the document it came from: ` +
                    "the defect is in that document, not in the totalling, and nothing here was adjusted to hide it.",
            sources: sourceReport(s),
            notes: [...degradedNotes(s), ...led.notes],
            bank_reconciliation: ledgerHead(led, s, bank).bank_reconciliation,
        });
    }
    catch (e) {
        return fail(e.message);
    }
});
server.registerTool("ledger_lines", {
    title: "List ledger lines",
    description: "List the ledger lines for a period, filtered by account, source server or document id, and date. Each line carries its debit, credit and bank_ref, the same field the Pro CSV lays out as a column. Free and unlimited.",
    inputSchema: {
        from: fromArg, to: toArg, currency: currencyArg,
        account: str("account", MAX_NAME).optional().describe('Only this account, e.g. cash, receivables, vat_output, or a category prefix such as "expenses"'),
        source: str("source", MAX_NAME).optional().describe("Only lines derived from this server: invoice, billing-docs, deposits, expense-tracker or asset-register"),
        source_id: str("source_id", MAX_NAME).optional().describe("Only lines derived from this document, e.g. INV-2026-0001"),
        since: str("since", 10).optional().describe("Only lines dated on or after this date, YYYY-MM-DD"),
        until: str("until", 10).optional().describe("Only lines dated on or before this date, YYYY-MM-DD"),
        limit: z.number().int().min(1).max(MAX_ROWS).optional().describe(`Maximum rows, default and ceiling ${MAX_ROWS}`),
    },
}, async (a) => {
    try {
        const { s, led } = derive(a.from, a.to, a.currency);
        if (a.since)
            checkDate(a.since, "since");
        if (a.until)
            checkDate(a.until, "until");
        const rows = filterLines(led, { account: a.account, source: a.source, source_id: a.source_id, from: a.since, to: a.until });
        const shown = rows.slice(0, a.limit ?? MAX_ROWS);
        const debits = shown.reduce((x, l) => x + l.debit_minor, 0);
        const credits = shown.reduce((x, l) => x + l.credit_minor, 0);
        return json({
            period: { from: led.from, to: led.to }, currency: led.currency,
            matched: rows.length, returned: shown.length,
            debits: money(debits, led.currency), debits_minor: debits,
            credits: money(credits, led.currency), credits_minor: credits,
            lines: shown.map(lineJson),
            note: a.account || a.source || a.source_id || a.since || a.until
                ? "A filtered set of lines is one side of entries whose other side was filtered out, so these totals are not expected to be equal. Only the whole period balances."
                : "Unfiltered, so the debits and the credits above are the trial balance.",
            sources: sourceReport(s),
            notes: [...degradedNotes(s), ...led.notes],
        });
    }
    catch (e) {
        return fail(e.message);
    }
});
server.registerTool("month_close", {
    title: "Close a month",
    description: "List what a month leaves unposted or inconsistent: invoices with no VAT rate, bank debits with no expense, deposits applied to unknown invoices. Then close it with a trial balance snapshot. Pro.",
    inputSchema: {
        month: str("month", 7).describe("The month to close, YYYY-MM"),
        currency: currencyArg,
        dry_run: z.boolean().optional().describe("Report the exceptions and the trial balance without writing the close. Default false"),
    },
}, async (a) => {
    try {
        requirePro("month_close", "month_close");
        const { month, from, to } = checkMonth(a.month);
        const { s, led, bank } = derive(from, to, a.currency);
        const tb = trialBalance(led);
        const exceptions = led.exceptions.map((x) => ({ kind: x.kind, source: x.source, source_id: x.source_id, date: x.date, message: x.message }));
        const balances = {};
        for (const acc of tb.accounts)
            balances[acc.account] = acc.balance_minor;
        const previous = findClose(getCloses(), month, led.currency);
        const drift = previous && (previous.debits_minor !== tb.debits_minor || previous.credits_minor !== tb.credits_minor);
        const body = {
            month, currency: led.currency, period: { from, to },
            trial_balance: {
                balanced: tb.balanced,
                debits: money(tb.debits_minor, led.currency), debits_minor: tb.debits_minor,
                credits: money(tb.credits_minor, led.currency), credits_minor: tb.credits_minor,
                imbalance_minor: tb.imbalance_minor,
            },
            exceptions_by_kind: exceptions.reduce((acc, x) => { acc[x.kind] = (acc[x.kind] ?? 0) + 1; return acc; }, {}),
            exceptions,
            purchase_commitments_open: led.memos.length,
            bank_reconciliation: { matched: bank.matched, bank_rows_unmatched: bank.unmatchedBank, posted_cash_without_bank_evidence: bank.unmatchedCash },
            previously_closed: previous ? { closed: previous.closed, debits_minor: previous.debits_minor, credits_minor: previous.credits_minor } : undefined,
            drift: drift
                ? `This month was closed on ${previous.closed} with ${previous.debits_minor} minor units of debits and now derives ${tb.debits_minor}. ` +
                    "A sibling store changed after the close. The snapshot is what the books said then; closing again replaces it and this line is the only place the change is visible."
                : undefined,
            sources: sourceReport(s),
            notes: [...degradedNotes(s), ...led.notes],
            basis: "A close records what the trial balance said at the moment of closing. It does not freeze the sibling stores, which this server does not own and never writes.",
        };
        if (a.dry_run)
            return json({ ...body, closed: false, dry_run: true });
        const rec = await locked(() => {
            const list = getCloses();
            const now = new Date().toISOString();
            const row = {
                month, currency: led.currency, closed: now,
                debits_minor: tb.debits_minor, credits_minor: tb.credits_minor, imbalance_minor: tb.imbalance_minor,
                balances, open_exceptions: exceptions.map((x) => `${x.kind}: ${x.source_id}`),
            };
            const at = list.findIndex((c) => c.month === month && c.currency === led.currency);
            if (at >= 0)
                list[at] = row;
            else
                list.push(row);
            setCloses(list);
            return row;
        });
        return json({ ...body, closed: true, closed_at: rec.closed, snapshot_accounts: Object.keys(balances).length });
    }
    catch (e) {
        return fail(e.message);
    }
});
server.registerTool("ledger_export_csv", {
    title: "Export the ledger as CSV",
    description: "Return the period's ledger lines as RFC 4180 CSV, one row per leg including bank_ref. No file is written. Pro, but ledger_lines returns these same fields free and unlimited; this only lays them out as CSV columns.",
    inputSchema: {
        from: fromArg, to: toArg, currency: currencyArg,
        account: str("account", MAX_NAME).optional().describe("Only this account or category prefix"),
        source: str("source", MAX_NAME).optional().describe("Only lines derived from this server"),
    },
}, async (a) => {
    try {
        requirePro("ledger_export_csv", "ledger_export_csv", LEDGER_EXPORT_CSV_NOTE);
        const { led } = derive(a.from, a.to, a.currency);
        const rows = filterLines(led, { account: a.account, source: a.source });
        return ok(toCsv(rows));
    }
    catch (e) {
        return fail(e.message);
    }
});
server.registerTool("ledger_report", {
    title: "Report movement and balance per account",
    description: "Report every account for a period with its debits, its credits, its movement and its closing balance, plus the purchase commitments held as a memo and the exceptions the period carries. Pro.",
    inputSchema: { from: fromArg, to: toArg, currency: currencyArg },
}, async (a) => {
    try {
        requirePro("ledger_report", "ledger_report");
        const { s, led, bank } = derive(a.from, a.to, a.currency);
        const tb = trialBalance(led);
        return json({
            ...ledgerHead(led, s, bank),
            accounts: tb.accounts.map((x) => {
                const side = accountFor(x.account).type;
                const movement = x.balance_minor;
                return {
                    account: x.account, account_name: x.account_name, type: side, lines: x.lines,
                    debits: money(x.debits_minor, led.currency), debits_minor: x.debits_minor,
                    credits: money(x.credits_minor, led.currency), credits_minor: x.credits_minor,
                    movement: money(movement, led.currency), movement_minor: movement,
                    balance: money(movement, led.currency), balance_minor: movement,
                    reads_as: movement === 0 ? "no movement"
                        : movement > 0 ? "a debit balance" : "a credit balance",
                };
            }),
            purchase_commitments: led.memos.map((m) => ({
                source_id: m.source_id, date: m.date, amount: money(m.amount_minor, led.currency),
                amount_minor: m.amount_minor, description: m.description,
            })),
            exceptions: led.exceptions.map((x) => ({ kind: x.kind, source_id: x.source_id, date: x.date, message: x.message })),
            basis: BASIS + " A balance here is the period's movement: this ledger opens at nothing and derives only what the period itself contains, " +
                "so a figure carried in from before the period is never invented.",
        });
    }
    catch (e) {
        return fail(e.message);
    }
});
gate.registerTools(server);
/* ------------------------------------------------------- resource and prompt */
server.registerResource("accounts", "ledger://accounts", {
    title: "Chart of accounts and the stores behind it",
    description: "The accounts this ledger posts to, which sibling store feeds each one, and the one directory this server writes.",
    mimeType: "application/json",
}, async () => {
    const s = readSources();
    return {
        contents: [{
                uri: "ledger://accounts", mimeType: "application/json",
                text: JSON.stringify({
                    accounts: [
                        { account: "cash", fed_by: "invoice payments, deposits received and refunded, expenses paid, assets bought", posted_from_bank: false },
                        { account: "receivables", fed_by: "invoices issued, credit notes, payments and deposit applications" },
                        { account: "revenue", fed_by: "invoice net, credit note net" },
                        { account: "vat_output", fed_by: "invoice tax, credit note tax" },
                        { account: "vat_input", fed_by: "the VAT taken out of a VAT-inclusive expense" },
                        { account: "expenses:<category>", fed_by: "expense-tracker, one account per category" },
                        { account: "deposits_held", fed_by: "deposits received, applied and refunded. A liability: it is the client's money" },
                        { account: "fixed_assets", fed_by: "asset-register, at the cost the asset entered service with" },
                        { account: "accumulated_depreciation", fed_by: "asset-register, the monthly charge" },
                        { account: "depreciation_expense", fed_by: "asset-register, the monthly charge" },
                        { account: "purchase_commitments", fed_by: "billing-docs open purchase orders. A MEMO and never posted" },
                    ],
                    reads: sourceReport(s),
                    writes: [{ store: "cash-book", dir: dataDir(), files: ["periods.json", "closes.json"] }],
                    today: today(),
                }, null, 2),
            }],
    };
});
server.registerPrompt("close_the_month", {
    title: "Close the month",
    description: "Walk a month close: build the ledger, prove the trial balance, work the exceptions, then close.",
    argsSchema: { month: z.string().describe("The month to close, YYYY-MM") },
}, ({ month }) => ({
    messages: [{
            role: "user",
            content: {
                type: "text",
                text: `Close ${month} in the cash book.\n\n` +
                    `1. Call trial_balance for ${month} and say whether it is zero. If it is not, read the offenders: each one names the document whose own figures do not add up.\n` +
                    `2. Call month_close with dry_run true and go through the exceptions: an invoice with no VAT rate, a bank debit with no expense behind it, a deposit applied to an invoice that does not exist.\n` +
                    `3. Fix each one in the server that OWNS it. Nothing is fixable here: this ledger writes into no book it reports on.\n` +
                    `4. Call month_close again to record the snapshot.`,
            },
        }],
}));
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`mcp-cash-book ${VERSION} ready; register at ${dataDir()}\n`);
