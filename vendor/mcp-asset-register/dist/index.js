#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLicenseGate, readSharedProfile, withFileLock } from "@theluckystrike/mcp-license";
import { z } from "zod";
import { VERSION } from "./version.js";
import { accumulatedTo, buildSchedule, chargeForMonth, MAX_MINOR, METHODS, monthKey, monthlyRows, parseDate, parseMonth, } from "./depreciation.js";
import { currencyDecimals, findRate, formatMoney, schemeTable, SCHEMES, TABLE_IDS, table } from "./tables.js";
import { dataDir, findAsset, getAssets, lockPath, nextAssetId, setAssets } from "./store.js";
/**
 * Free tier: ten assets in the register. Schedules are free and unlimited on every tier,
 * for the same reason the rate tables are: a depreciation rate is published by a tax
 * authority, and metering the reading of a public annex would be charging for the
 * government's work rather than for this one. Pro removes the asset cap and adds the
 * monthly journal and the register report, which are the two bookkeeping outputs.
 */
const FREE_ASSETS = 10;
const MAX_NAME = 200;
const MAX_TEXT = 2000;
const MAX_ROWS = 2000;
const gate = createLicenseGate({ product: "asset-register" });
const ok = (text) => ({ content: [{ type: "text", text }] });
const fail = (text) => ({ content: [{ type: "text", text: `Error: ${text}` }], isError: true });
const json = (v) => ok(JSON.stringify(v, null, 2));
const str = (field, max) => z.string().max(max, `${field} must be ${max} characters or fewer`);
/** Every mutation takes this server's lock. No other server's store is written, so there is only one. */
function locked(fn) {
    return withFileLock(lockPath(), fn, { timeoutMs: 20000 });
}
/* -------------------------------------------------------------- the profile */
/**
 * The shared business profile (`packages/mcp-license`, written by the invoice server's
 * `business_set`) has `name`, `address` and `default_currency` but NO country field, so
 * "which depreciation scheme applies to me" is not a fact this suite stores. Rather than
 * infer a country from a free-text address, the scheme is derived from
 * `default_currency`, which is a closed set, and every answer that uses it says in words
 * that it is a derivation. A profile with no currency yields no default scheme at all.
 */
const CURRENCY_TO_SCHEME = { PLN: "pl", GBP: "uk", USD: "us" };
function home() {
    const p = readSharedProfile();
    const currency = (p.default_currency ?? "").trim().toUpperCase() || undefined;
    const scheme = currency ? CURRENCY_TO_SCHEME[currency] : undefined;
    const how = !currency
        ? "the shared business profile has no default_currency, so there is no default scheme; pass scheme explicitly"
        : scheme
            ? `scheme "${scheme}" was derived from the shared profile's default_currency ${currency}. The profile has no country field, so this is a derivation, not a stored fact`
            : `the shared profile's default_currency ${currency} matches no bundled scheme (${SCHEMES.join(", ")}), so there is no default scheme`;
    return { currency, scheme, how };
}
/* ------------------------------------------------------------------- schema */
const schemeArg = z.enum(["pl", "uk", "us"]);
const methodArg = z.enum(METHODS);
function scheduleFor(a) {
    return buildSchedule({
        scheme: a.scheme, category: a.category, cost_minor: a.cost_minor, currency: a.currency,
        residual_minor: a.residual_minor, purchase_date: a.purchase_date, in_service_date: a.in_service_date,
        method: a.method, life_years: a.life_override, rate_pct: a.rate_override,
        declining_coefficient: a.declining_coefficient,
    });
}
function assetSummary(a) {
    return {
        id: a.id, name: a.name, scheme: a.scheme, category: a.category, category_name: a.category_name,
        currency: a.currency, cost_minor: a.cost_minor, cost: formatMoney(a.cost_minor, a.currency),
        residual_minor: a.residual_minor, method: a.method, rate_pct: a.rate_pct,
        life_years: a.life_years, in_service_date: a.in_service_date, project: a.project,
        disposed: a.disposal ? { date: a.disposal.date, result: a.disposal.result, result_minor: a.disposal.result_minor } : undefined,
    };
}
function capRefusal(count, toolName) {
    return `the free tier holds ${FREE_ASSETS} assets in the register and there are already ${count}. ` +
        `asset_schedule stays free and unlimited, so a schedule can still be produced for anything already in the register; only adding more is capped. ` +
        `Nothing was stored. asset_delete removes an asset nothing depends on and frees its slot again, so a row added by mistake is not a slot spent for good. ` +
        gate.upgradeText("an unlimited register", toolName);
}
/**
 * The identity of an asset as a caller states it, normalised: name and category folded to
 * lower case and collapsed whitespace, currency upper-cased, dates and money as stored.
 *
 * A create tool with no delete tool that accepts the same record twice spends a free-tier
 * slot the caller cannot get back, and the second row is almost never a second machine: a
 * retried call, a re-run script and a client that lost the first answer all look like
 * this. Two genuinely identical units are still a legitimate register, so the refusal
 * names the field that distinguishes them rather than the tier.
 */
function fingerprint(x) {
    const fold = (v) => v.trim().toLowerCase().replace(/\s+/g, " ");
    return [
        fold(x.name), x.scheme, fold(x.category), String(x.cost_minor), x.currency.trim().toUpperCase(),
        String(x.residual_minor), x.purchase_date.trim(), x.in_service_date.trim(), fold(x.method), String(x.life_years),
    ].join("|");
}
function duplicateRefusal(existing) {
    return `this is identical to ${existing.id} "${existing.name}", which is already in the register: same name, scheme ${existing.scheme}, ` +
        `category ${existing.category} ${existing.category_name}, cost ${formatMoney(existing.cost_minor, existing.currency)} ${existing.currency}, ` +
        `residual ${formatMoney(existing.residual_minor, existing.currency)}, purchase date ${existing.purchase_date}, in-service date ${existing.in_service_date}, ` +
        `${existing.method} over ${existing.life_years} years. Nothing was written and no free-tier slot was used. ` +
        `Two identical units are a legitimate register: give the second one a distinguishing name, such as a serial number, and it is accepted. ` +
        `If ${existing.id} was added by mistake, asset_delete removes it and frees its slot again.`;
}
/**
 * What already depends on an asset, in words. Only markers this server actually sets
 * count: a recorded disposal, which `asset_report` reports for the year and which carries
 * a gain or loss someone has filed, and the months `asset_journal` has posted, which are
 * stamped on the asset when the journal produces its line. An asset with either one is
 * refused by `asset_delete` rather than deleted, because deleting it would remove the cost
 * and the accumulated depreciation behind a figure that has already left this server.
 */
function dependents(a) {
    const out = [];
    if (a.disposal) {
        out.push(`a disposal is recorded against it on ${a.disposal.date} (${a.disposal.result} ${formatMoney(Math.abs(a.disposal.result_minor), a.currency)} ${a.currency}), which asset_report shows for ${a.disposal.date.slice(0, 4)}`);
    }
    const months = a.journaled ?? [];
    if (months.length) {
        out.push(`asset_journal has already journaled it for ${months.length} month(s): ${months.join(", ")}`);
    }
    return out;
}
/** The last month a stored asset is still on the books, so a disposed asset stops charging. */
function lastChargeMonth(a) {
    return a.disposal ? a.disposal.date.slice(0, 7) : undefined;
}
/* ------------------------------------------------------------------- server */
const server = new McpServer({ name: "mcp-asset-register", version: VERSION }, { capabilities: { tools: {}, resources: {}, prompts: {} } });
server.registerTool("asset_add", {
    title: "Add a fixed asset",
    description: "Add one fixed asset to the register and return its id with the rate, useful life and convention taken from the bundled tax table. Cost and residual are whole minor units. Free tier holds ten assets.",
    inputSchema: {
        name: str("name", MAX_NAME).min(1, "name is required").describe('What the asset is, e.g. "MacBook Pro 16" or "Delivery van"'),
        scheme: schemeArg.optional().describe('"pl" Polish KST annex rates, "uk" HMRC capital allowance pools, "us" IRS MACRS GDS. Omit to derive it from the shared business profile currency'),
        category: str("category", MAX_NAME).min(1, "category is required").describe('A code or name from the bundled table, e.g. "487" or "Computers and computer sets" (pl), "main" (uk), "5-year" (us). Read assets://categories for the list'),
        cost_minor: z.number().int("cost_minor must be a whole number of minor units").describe("Acquisition cost in MINOR units (integer cents/grosze), e.g. 549900 for 5499.00. Never a decimal"),
        currency: z.string().regex(/^[A-Za-z]{3}$/, "currency must be a 3-letter ISO code such as PLN").optional().describe("ISO code. Defaults to the shared business profile currency, else the scheme table currency"),
        purchase_date: str("purchase_date", 10).describe("ISO date YYYY-MM-DD the asset was bought"),
        in_service_date: str("in_service_date", 10).optional().describe("ISO date YYYY-MM-DD the asset entered use and the register. Defaults to purchase_date"),
        residual_minor: z.number().int().optional().describe("Residual or salvage value in MINOR units, default 0. Must be less than cost. MACRS ignores it and the answer says so"),
        method: methodArg.optional().describe('"straight-line" or "declining-balance". Default: the table row method, straight-line for the Polish annex and the reducing-balance pool rate for the UK'),
        life_years: z.number().optional().describe("Override the useful life derived from the table, in years. The answer reports that it was an override"),
        rate_pct: z.number().optional().describe("Override the annual percentage derived from the table. Use for a lowered Polish rate under art. 16i"),
        declining_coefficient: z.number().optional().describe("Declining-balance coefficient. Polish default 2.0, capped by the table; ignored with straight-line"),
        project: str("project", MAX_NAME).optional().describe("Project, department or cost centre this asset belongs to"),
        note: str("note", MAX_TEXT).optional(),
    },
}, async (a) => {
    try {
        const h = home();
        const scheme = (a.scheme ?? h.scheme);
        if (!scheme)
            return fail(`no scheme was given and none could be derived: ${h.how}. Pass scheme as one of ${SCHEMES.join(", ")}.`);
        const t = schemeTable(scheme);
        const currency = (a.currency ?? h.currency ?? t.header.currency).toUpperCase();
        const purchase = a.purchase_date.trim();
        const inService = (a.in_service_date ?? purchase).trim();
        const method = a.method ?? (findRate(scheme, a.category)?.method ?? "straight-line");
        const schedule = buildSchedule({
            scheme, category: a.category, cost_minor: a.cost_minor, currency,
            residual_minor: a.residual_minor ?? 0, purchase_date: purchase, in_service_date: inService,
            method, life_years: a.life_years, rate_pct: a.rate_pct, declining_coefficient: a.declining_coefficient,
        });
        return await locked(() => {
            const list = getAssets();
            // The duplicate check runs before the cap, on every tier: a byte-identical record is
            // refused whether or not there is a slot left, and refusing it before the cap means
            // the answer names the id that is already there rather than the tier.
            const wanted = fingerprint({
                name: a.name, scheme, category: schedule.category.code, cost_minor: a.cost_minor, currency,
                residual_minor: a.residual_minor ?? 0, purchase_date: purchase, in_service_date: inService,
                method, life_years: schedule.useful_life_years,
            });
            // A disposed asset is off the register, so an identical replacement is a real one.
            const twin = list.find((x) => !x.disposal && fingerprint(x) === wanted);
            if (twin)
                return fail(duplicateRefusal(twin));
            if (!gate.isPro() && list.length >= FREE_ASSETS)
                return fail(capRefusal(list.length, "asset_add"));
            const now = new Date().toISOString();
            const id = nextAssetId(inService.slice(0, 4), list.map((x) => x.id));
            const asset = {
                id, name: a.name.trim(), scheme, category: schedule.category.code, category_name: schedule.category.name_en,
                cost_minor: a.cost_minor, currency, residual_minor: a.residual_minor ?? 0,
                purchase_date: purchase, in_service_date: inService, method,
                life_years: schedule.useful_life_years, life_source: schedule.life_source, rate_pct: schedule.rate_pct,
                declining_coefficient: schedule.declining_coefficient,
                life_override: a.life_years, rate_override: a.rate_pct,
                project: a.project?.trim() || undefined, note: a.note?.trim() || undefined,
                created: now, updated: now,
            };
            list.push(asset);
            setAssets(list);
            const notes = [...schedule.notes, h.how];
            if (!gate.isPro())
                notes.push(`Free tier: ${list.length} of ${FREE_ASSETS} assets. asset_journal and asset_report are Pro.`);
            return json({
                added: assetSummary(asset),
                rate_pct: schedule.rate_pct, useful_life_years: schedule.useful_life_years, life_source: schedule.life_source,
                convention: schedule.convention, first_charge_month: schedule.first_charge_month,
                depreciable_base_minor: schedule.depreciable_base_minor,
                depreciable_base: formatMoney(schedule.depreciable_base_minor, currency),
                periods: schedule.periods.length,
                source: schedule.source,
                notes,
            });
        });
    }
    catch (e) {
        return fail(e.message);
    }
});
server.registerTool("asset_list", {
    title: "List the fixed asset register",
    description: "List the assets in the register with cost, method, rate and net book value at a date, filtered by scheme, category, project, currency or disposal state. Free and unlimited.",
    inputSchema: {
        scheme: schemeArg.optional().describe("Only assets on this tax scheme"),
        category: str("category", MAX_NAME).optional().describe("Only assets in this table category code or name"),
        project: str("project", MAX_NAME).optional().describe("Only assets on this project or cost centre"),
        currency: z.string().regex(/^[A-Za-z]{3}$/).optional().describe("Only assets held in this currency"),
        as_of: str("as_of", 10).optional().describe("Value the register at this month or date, YYYY-MM or YYYY-MM-DD. Default today"),
        include_disposed: z.boolean().optional().describe("Include assets already disposed of. Default false"),
        limit: z.number().int().min(1).max(MAX_ROWS).optional().describe(`Maximum rows, default and ceiling ${MAX_ROWS}`),
    },
}, async (a) => {
    try {
        const asOfMonth = a.as_of ? monthKey(parseMonth(a.as_of, "as_of").y, parseMonth(a.as_of, "as_of").m) : new Date().toISOString().slice(0, 7);
        let rows = getAssets();
        if (a.scheme)
            rows = rows.filter((x) => x.scheme === a.scheme);
        if (a.category)
            rows = rows.filter((x) => x.category.toLowerCase() === a.category.trim().toLowerCase() || x.category_name.toLowerCase() === a.category.trim().toLowerCase());
        if (a.project)
            rows = rows.filter((x) => (x.project ?? "").toLowerCase() === a.project.trim().toLowerCase());
        if (a.currency)
            rows = rows.filter((x) => x.currency === a.currency.toUpperCase());
        if (!a.include_disposed)
            rows = rows.filter((x) => !x.disposal);
        const out = rows.slice(0, a.limit ?? MAX_ROWS).map((x) => {
            const s = scheduleFor(x);
            const stop = lastChargeMonth(x);
            const upTo = stop && stop < asOfMonth ? stop : asOfMonth;
            const acc = accumulatedTo(s, upTo);
            return {
                ...assetSummary(x),
                accumulated_minor: acc, accumulated: formatMoney(acc, x.currency),
                nbv_minor: x.cost_minor - acc, nbv: formatMoney(x.cost_minor - acc, x.currency),
            };
        });
        const totals = new Map();
        for (const r of out) {
            const t = totals.get(r.currency) ?? { currency: r.currency, cost_minor: 0, accumulated_minor: 0, nbv_minor: 0 };
            t.cost_minor += r.cost_minor;
            t.accumulated_minor += r.accumulated_minor;
            t.nbv_minor += r.nbv_minor;
            totals.set(r.currency, t);
        }
        return json({
            as_of: asOfMonth, count: rows.length, returned: out.length, assets: out,
            totals_by_currency: [...totals.values()].map((t) => ({ ...t, cost: formatMoney(t.cost_minor, t.currency), accumulated: formatMoney(t.accumulated_minor, t.currency), nbv: formatMoney(t.nbv_minor, t.currency) })),
            note: "Currencies are never added together. This server holds no exchange rate, so one number over a PLN register and a USD one would be an invented one.",
        });
    }
    catch (e) {
        return fail(e.message);
    }
});
server.registerTool("asset_schedule", {
    title: "Build a depreciation schedule",
    description: "Build the depreciation schedule for a stored asset, or price one not yet in the register, per year or per month, to zero or residual, with the table convention applied and the periods summing exactly to the base. Free.",
    inputSchema: {
        asset: str("asset", MAX_NAME).optional().describe("Asset id such as ASSET-2026-0001, or an exact or partial name. Omit and pass the fields below to price an asset that is not in the register"),
        scheme: schemeArg.optional().describe("Scheme, when pricing an asset that is not in the register"),
        category: str("category", MAX_NAME).optional().describe("Table category code or name, when pricing an asset that is not in the register"),
        cost_minor: z.number().int().optional().describe("Cost in MINOR units, when pricing an asset that is not in the register"),
        currency: z.string().regex(/^[A-Za-z]{3}$/).optional().describe("ISO code, when pricing an asset that is not in the register"),
        purchase_date: str("purchase_date", 10).optional().describe("ISO date YYYY-MM-DD, when pricing an asset that is not in the register"),
        in_service_date: str("in_service_date", 10).optional().describe("ISO date YYYY-MM-DD the asset entered use. Defaults to purchase_date"),
        residual_minor: z.number().int().optional().describe("Residual in MINOR units, default 0"),
        method: methodArg.optional().describe('"straight-line" or "declining-balance"'),
        life_years: z.number().optional().describe("Override the useful life from the table, in years"),
        rate_pct: z.number().optional().describe("Override the annual percentage from the table"),
        declining_coefficient: z.number().optional().describe("Declining-balance coefficient; ignored with straight-line"),
        granularity: z.enum(["year", "month"]).optional().describe('"year" for one row per period, "month" for the monthly charge. Default "year"'),
    },
}, async (a) => {
    try {
        let schedule;
        let asset;
        if (a.asset) {
            asset = findAsset(getAssets(), a.asset);
            if (!asset)
                return fail(`no asset matches "${a.asset}". Run asset_list to see the ids.`);
            schedule = scheduleFor(asset);
        }
        else {
            const h = home();
            const scheme = (a.scheme ?? h.scheme);
            if (!scheme)
                return fail(`no scheme was given and none could be derived: ${h.how}.`);
            if (!a.category)
                return fail("category is required when no stored asset is named");
            if (a.cost_minor === undefined)
                return fail("cost_minor is required when no stored asset is named");
            if (!a.purchase_date)
                return fail("purchase_date is required when no stored asset is named");
            const t = schemeTable(scheme);
            schedule = buildSchedule({
                scheme, category: a.category, cost_minor: a.cost_minor,
                currency: (a.currency ?? h.currency ?? t.header.currency).toUpperCase(),
                residual_minor: a.residual_minor ?? 0,
                purchase_date: a.purchase_date, in_service_date: (a.in_service_date ?? a.purchase_date),
                method: a.method ?? (findRate(scheme, a.category)?.method ?? "straight-line"),
                life_years: a.life_years, rate_pct: a.rate_pct, declining_coefficient: a.declining_coefficient,
            });
        }
        const monthly = a.granularity === "month" ? monthlyRows(schedule) : undefined;
        const sum = schedule.periods.reduce((x, p) => x + p.amount_minor, 0);
        return json({
            asset: asset ? assetSummary(asset) : undefined,
            scheme: schedule.scheme, table: schedule.table,
            category: { code: schedule.category.code, name: schedule.category.name_en, name_pl: schedule.category.name_pl, note: schedule.category.note },
            method: schedule.method, convention: schedule.convention, rate_pct: schedule.rate_pct,
            useful_life_years: schedule.useful_life_years, life_source: schedule.life_source,
            declining_coefficient: schedule.declining_coefficient,
            currency: schedule.currency,
            cost_minor: schedule.cost_minor, residual_applied_minor: schedule.residual_applied_minor,
            depreciable_base_minor: schedule.depreciable_base_minor,
            first_charge_month: schedule.first_charge_month,
            periods: schedule.periods,
            months: monthly,
            total_minor: sum, total: formatMoney(sum, schedule.currency),
            check: sum === schedule.depreciable_base_minor
                ? `the ${schedule.periods.length} periods sum to the depreciable base exactly, to the minor unit`
                : `PERIODS DO NOT SUM TO THE BASE: ${sum} against ${schedule.depreciable_base_minor}. This is a defect; do not post these figures.`,
            source: schedule.source,
            notes: schedule.notes,
        });
    }
    catch (e) {
        return fail(e.message);
    }
});
/**
 * D-J1. `asset_journal` builds an `expense_add`-ready payload and does NOT write into the
 * expense ledger.
 *
 * servers/expense-tracker exposes no `./lib` entry point in its package.json (its
 * `exports` map has only `.`), so there is no published store API to call. Its id
 * allocation, its category-rule matching, its VAT split and its currency defaulting all
 * live inside `src/index.ts`, inside the `expense_add` handler, under that server's own
 * lock. Appending a row to its `data.json` directly would create an entry with none of
 * those applied: a row that looks native and is not.
 *
 * So the safe path is the one servers/per-diem and servers/kanban already use: hand back
 * the exact arguments for the owning server's own tool, one payload per currency, because
 * `expense_add` takes one currency per call and adding a PLN charge to a USD one would be
 * a made-up number.
 */
server.registerTool("asset_journal", {
    title: "Journal the month's depreciation",
    description: "Return the depreciation journal for one month: debit depreciation expense and credit accumulated depreciation, per asset and in total, plus an expense_add-ready payload per currency. It writes no expense. Pro.",
    inputSchema: {
        month: str("month", 10).describe("The month to journal, YYYY-MM. A date YYYY-MM-DD is read as its month"),
        scheme: schemeArg.optional().describe("Only assets on this tax scheme"),
        project: str("project", MAX_NAME).optional().describe("Only assets on this project or cost centre"),
        expense_account: str("expense_account", MAX_NAME).optional().describe('Debit account name. Default "Depreciation expense"'),
        accumulated_account: str("accumulated_account", MAX_NAME).optional().describe('Credit account name. Default "Accumulated depreciation"'),
        category: str("category", MAX_NAME).optional().describe('Expense category to put on the expense_add payload. Default "depreciation"'),
    },
}, async (a) => {
    try {
        if (!gate.isPro())
            return fail(gate.upgradeText("the depreciation journal", "asset_journal"));
        const m = parseMonth(a.month, "month");
        const month = monthKey(m.y, m.m);
        const debit = (a.expense_account ?? "Depreciation expense").trim();
        const credit = (a.accumulated_account ?? "Accumulated depreciation").trim();
        let rows = getAssets();
        if (a.scheme)
            rows = rows.filter((x) => x.scheme === a.scheme);
        if (a.project)
            rows = rows.filter((x) => (x.project ?? "").toLowerCase() === a.project.trim().toLowerCase());
        const lines = [];
        const totals = new Map();
        for (const asset of rows) {
            const stop = lastChargeMonth(asset);
            if (stop && month > stop)
                continue;
            const s = scheduleFor(asset);
            const amount = chargeForMonth(s, month);
            if (amount === 0)
                continue;
            lines.push({
                asset: asset.id, name: asset.name, currency: asset.currency,
                debit_account: debit, credit_account: credit,
                debit_minor: amount, credit_minor: amount,
                amount: formatMoney(amount, asset.currency),
                memo: `${asset.id} ${asset.name} | ${asset.scheme.toUpperCase()} ${asset.category} ${asset.category_name} | ${asset.method} ${asset.rate_pct} percent | ${month}`,
                project: asset.project,
            });
            totals.set(asset.currency, (totals.get(asset.currency) ?? 0) + amount);
        }
        // The journal marks the register: each asset it produced a line for records the month.
        // Nothing is written into the expense ledger (see why_not_written below), but "has
        // anything been posted for this asset" has to be answerable, or asset_delete would
        // remove the cost behind a figure that is already in someone's books.
        if (lines.length) {
            const journaled = new Set(lines.map((l) => l.asset));
            await locked(() => {
                const all = getAssets();
                let touched = false;
                for (const asset of all) {
                    if (!journaled.has(asset.id))
                        continue;
                    const months = asset.journaled ?? [];
                    if (months.includes(month))
                        continue;
                    months.push(month);
                    months.sort();
                    asset.journaled = months;
                    asset.updated = new Date().toISOString();
                    touched = true;
                }
                if (touched)
                    setAssets(all);
            });
        }
        const category = (a.category ?? "depreciation").trim();
        const lastDay = new Date(Date.UTC(m.y, m.m, 0)).getUTCDate();
        const date = `${month}-${String(lastDay).padStart(2, "0")}`;
        const payloads = [...totals.entries()].map(([currency, minor]) => {
            const d = currencyDecimals(currency);
            return {
                tool: "expense_add", server: "expense-tracker",
                arguments: {
                    amount: d === 0 ? minor : Number((minor / 10 ** d).toFixed(d)),
                    currency, category, date, billable: false,
                    merchant: `Depreciation ${month}`,
                    note: `Depreciation journal ${month}, ${lines.filter((l) => l.currency === currency).length} asset(s): debit ${debit}, credit ${credit}`.slice(0, MAX_TEXT),
                },
            };
        });
        return json({
            month, lines,
            totals_by_currency: [...totals.entries()].map(([currency, minor]) => ({
                currency, debit_account: debit, credit_account: credit,
                debit_minor: minor, credit_minor: minor, amount: formatMoney(minor, currency),
            })),
            balanced: lines.every((l) => l.debit_minor === l.credit_minor),
            payloads,
            how: "Pass each payload's `arguments` to the expense-tracker server's expense_add tool, one call per payload. `amount` is in MAJOR units because that is what expense_add takes; the minor-unit figures are on the lines above.",
            why_not_written: "This server does not write into the expense ledger. servers/expense-tracker publishes no library entry point, and its id counter, category rules, VAT split and currency defaults all live inside its own expense_add handler under its own lock. Appending a row to its data.json directly would create an expense with none of those applied: it would look native and would not be.",
            no_vat: "No vat_rate is set on the payload. Depreciation is a book charge, not a purchase, and there is no input VAT on it; putting a rate here would invent a deductible amount.",
            marked: lines.length
                ? `${month} is now recorded on ${lines.length} asset(s) in the register, so asset_delete refuses them by name rather than deleting the cost behind a line that has been posted. No expense was written.`
                : "No asset was charged this month, so nothing was marked.",
            note: "Currencies are never added together, and an asset disposed of before this month is excluded: depreciation is charged up to and including the month of disposal, then stops.",
        });
    }
    catch (e) {
        return fail(e.message);
    }
});
server.registerTool("asset_dispose", {
    title: "Dispose of an asset",
    description: "Record the sale, scrapping or write-off of an asset on a date for a proceeds amount, and return the gain or loss against net book value at that date. Free.",
    inputSchema: {
        asset: str("asset", MAX_NAME).min(1, "asset is required").describe("Asset id such as ASSET-2026-0001, or an exact or partial name"),
        date: str("date", 10).describe("ISO date YYYY-MM-DD the asset left the business. It cannot be before the in-service date"),
        proceeds_minor: z.number().int().optional().describe("Sale proceeds in MINOR units, default 0 for a scrapping or a write-off"),
        note: str("note", MAX_TEXT).optional().describe("What happened, e.g. sold to a dealer, written off after a fire"),
    },
}, async (a) => {
    try {
        const proceeds = a.proceeds_minor ?? 0;
        if (!Number.isInteger(proceeds) || proceeds < 0)
            return fail("proceeds_minor must be a whole number of minor units, zero or more");
        if (proceeds > MAX_MINOR)
            return fail(`proceeds are over the ${MAX_MINOR} minor unit ceiling`);
        const d = parseDate(a.date, "date");
        return await locked(() => {
            const list = getAssets();
            const asset = findAsset(list, a.asset);
            if (!asset)
                return fail(`no asset matches "${a.asset}". Run asset_list to see the ids.`);
            if (asset.disposal)
                return fail(`${asset.id} was already disposed of on ${asset.disposal.date}. Nothing was written.`);
            const inService = parseDate(asset.in_service_date, "in_service_date");
            if (d.y * 10000 + d.m * 100 + d.d < inService.y * 10000 + inService.m * 100 + inService.d) {
                return fail(`disposal date ${a.date} is before ${asset.id} entered service on ${asset.in_service_date}. ` +
                    `An asset cannot leave the business before it joined it, and booking it would produce a gain against a book value that never existed. Nothing was written.`);
            }
            const s = scheduleFor(asset);
            const month = monthKey(d.y, d.m);
            const accumulated = accumulatedTo(s, month);
            const nbv = asset.cost_minor - accumulated;
            const result = proceeds - nbv;
            const disposal = {
                date: a.date.trim(), proceeds_minor: proceeds, accumulated_minor: accumulated, nbv_minor: nbv,
                result_minor: result, result: (result > 0 ? "gain" : result < 0 ? "loss" : "break-even"),
                note: a.note?.trim() || undefined,
            };
            asset.disposal = disposal;
            asset.updated = new Date().toISOString();
            setAssets(list);
            return json({
                disposed: assetSummary(asset),
                date: disposal.date,
                accumulated_minor: accumulated, accumulated: formatMoney(accumulated, asset.currency),
                nbv_minor: nbv, nbv: formatMoney(nbv, asset.currency),
                proceeds_minor: proceeds, proceeds: formatMoney(proceeds, asset.currency),
                result: disposal.result, result_minor: result, amount: formatMoney(Math.abs(result), asset.currency),
                journal: [
                    { debit_account: "Cash or receivable", debit_minor: proceeds, credit_minor: 0 },
                    { debit_account: "Accumulated depreciation", debit_minor: accumulated, credit_minor: 0 },
                    { credit_account: "Fixed assets at cost", debit_minor: 0, credit_minor: asset.cost_minor },
                    result >= 0
                        ? { credit_account: "Gain on disposal", debit_minor: 0, credit_minor: result }
                        : { debit_account: "Loss on disposal", debit_minor: -result, credit_minor: 0 },
                ],
                basis: `depreciation is charged up to and including the month of disposal (${month}), which is the Polish rule in art. 16h ust. 1 pkt 1 and the usual book convention; the accumulated figure above is the sum of the monthly charges through that month`,
                notes: s.notes,
            });
        });
    }
    catch (e) {
        return fail(e.message);
    }
});
/**
 * D-D1. The counterpart to `asset_add`. A create tool with no delete tool makes every
 * mistaken row permanent, and on the free tier a mistaken row is a slot the caller cannot
 * get back except by buying a key, which is a tier that punishes a typo rather than one
 * that meters a feature. So the delete is free, and it is narrow: it removes a row nothing
 * else has consumed yet, and it refuses the moment something has.
 */
server.registerTool("asset_delete", {
    title: "Delete an asset",
    description: "Remove one asset from the register when nothing depends on it: not disposed of, never journaled. Its free-tier slot is free again. An asset with a dependent is refused and the dependent is named. Free.",
    inputSchema: {
        asset: str("asset", MAX_NAME).min(1, "asset is required").describe("Asset id such as ASSET-2026-0001, or an exact or partial name"),
    },
}, async (a) => {
    try {
        return await locked(() => {
            const list = getAssets();
            const asset = findAsset(list, a.asset);
            if (!asset)
                return fail(`no asset matches "${a.asset}". Run asset_list to see the ids.`);
            const blockers = dependents(asset);
            if (blockers.length) {
                return fail(`${asset.id} "${asset.name}" has a dependent and was not deleted: ${blockers.join("; ")}. ` +
                    `Deleting it would remove the cost and the accumulated depreciation behind a figure that has already left this server, so the row stays. Nothing was written.`);
            }
            const kept = list.filter((x) => x.id !== asset.id);
            setAssets(kept);
            const notes = [
                "The id is not reused: asset ids are allocated from a counter and checked against the register, so a deleted number is never issued to a different asset.",
            ];
            if (!gate.isPro())
                notes.push(`Free tier: ${kept.length} of ${FREE_ASSETS} assets, so ${FREE_ASSETS - kept.length} slot(s) are open again.`);
            return json({
                deleted: assetSummary(asset),
                assets_remaining: kept.length,
                free_slots_open: gate.isPro() ? undefined : Math.max(0, FREE_ASSETS - kept.length),
                checked: "no disposal is recorded against it and asset_journal has never journaled it, so nothing downstream depends on it",
                notes,
            });
        });
    }
    catch (e) {
        return fail(e.message);
    }
});
server.registerTool("asset_report", {
    title: "Report the register",
    description: "Report net book value by category and currency at a date, the year's depreciation charge, and every disposal in the year with its gain or loss. Pro.",
    inputSchema: {
        year: z.number().int().optional().describe("Calendar year to report, e.g. 2026. Default the year of as_of, else this year"),
        as_of: str("as_of", 10).optional().describe("Value the register at this month or date, YYYY-MM or YYYY-MM-DD. Default the last day of the year"),
        scheme: schemeArg.optional().describe("Only assets on this tax scheme"),
        project: str("project", MAX_NAME).optional().describe("Only assets on this project or cost centre"),
    },
}, async (a) => {
    try {
        if (!gate.isPro())
            return fail(gate.upgradeText("the register report", "asset_report"));
        const year = a.year ?? (a.as_of ? parseMonth(a.as_of, "as_of").y : new Date().getUTCFullYear());
        const asOf = a.as_of ? monthKey(parseMonth(a.as_of, "as_of").y, parseMonth(a.as_of, "as_of").m) : `${year}-12`;
        let rows = getAssets();
        if (a.scheme)
            rows = rows.filter((x) => x.scheme === a.scheme);
        if (a.project)
            rows = rows.filter((x) => (x.project ?? "").toLowerCase() === a.project.trim().toLowerCase());
        const byCategory = new Map();
        const disposals = [];
        const chargeByCurrency = new Map();
        for (const asset of rows) {
            const s = scheduleFor(asset);
            const stop = lastChargeMonth(asset);
            const upTo = stop && stop < asOf ? stop : asOf;
            const accumulated = accumulatedTo(s, upTo);
            const charge = monthlyRows(s)
                .filter((r) => r.month.slice(0, 4) === String(year) && r.month <= upTo)
                .reduce((x, r) => x + r.amount_minor, 0);
            chargeByCurrency.set(asset.currency, (chargeByCurrency.get(asset.currency) ?? 0) + charge);
            if (asset.disposal && asset.disposal.date.slice(0, 4) === String(year)) {
                disposals.push({
                    asset: asset.id, name: asset.name, currency: asset.currency, date: asset.disposal.date,
                    cost_minor: asset.cost_minor, accumulated_minor: asset.disposal.accumulated_minor,
                    nbv_minor: asset.disposal.nbv_minor, proceeds_minor: asset.disposal.proceeds_minor,
                    result: asset.disposal.result, result_minor: asset.disposal.result_minor,
                    amount: formatMoney(Math.abs(asset.disposal.result_minor), asset.currency),
                });
                continue; // no longer on the books at the reporting date
            }
            const key = `${asset.currency}|${asset.scheme}|${asset.category}`;
            const row = byCategory.get(key) ?? {
                currency: asset.currency, scheme: asset.scheme, category: asset.category,
                category_name: asset.category_name, count: 0, cost_minor: 0, accumulated_minor: 0, nbv_minor: 0, charge_minor: 0,
            };
            row.count += 1;
            row.cost_minor += asset.cost_minor;
            row.accumulated_minor += accumulated;
            row.nbv_minor += asset.cost_minor - accumulated;
            row.charge_minor += charge;
            byCategory.set(key, row);
        }
        const cats = [...byCategory.values()].sort((x, y) => (x.currency + x.scheme + x.category).localeCompare(y.currency + y.scheme + y.category));
        const totals = new Map();
        for (const c of cats) {
            const t = totals.get(c.currency) ?? { currency: c.currency, cost_minor: 0, accumulated_minor: 0, nbv_minor: 0 };
            t.cost_minor += c.cost_minor;
            t.accumulated_minor += c.accumulated_minor;
            t.nbv_minor += c.nbv_minor;
            totals.set(c.currency, t);
        }
        const gains = new Map();
        for (const d of disposals)
            gains.set(d.currency, (gains.get(d.currency) ?? 0) + d.result_minor);
        return json({
            year, as_of: asOf, assets: rows.length,
            by_category: cats.map((c) => ({ ...c, cost: formatMoney(c.cost_minor, c.currency), accumulated: formatMoney(c.accumulated_minor, c.currency), nbv: formatMoney(c.nbv_minor, c.currency), charge: formatMoney(c.charge_minor, c.currency) })),
            nbv_by_currency: [...totals.values()].map((t) => ({ ...t, cost: formatMoney(t.cost_minor, t.currency), accumulated: formatMoney(t.accumulated_minor, t.currency), nbv: formatMoney(t.nbv_minor, t.currency) })),
            charge_by_currency: [...chargeByCurrency.entries()].map(([currency, minor]) => ({ currency, charge_minor: minor, charge: formatMoney(minor, currency) })),
            disposals,
            disposal_result_by_currency: [...gains.entries()].map(([currency, minor]) => ({ currency, result_minor: minor, result: minor >= 0 ? "gain" : "loss", amount: formatMoney(Math.abs(minor), currency) })),
            note: "Currencies are never added together: this server holds no exchange rate. A disposed asset is out of the net book value table from its disposal date and appears only under disposals.",
        });
    }
    catch (e) {
        return fail(e.message);
    }
});
gate.registerTools(server);
/* ---------------------------------------------------------------- resource */
server.registerResource("categories", "assets://categories", {
    title: "Bundled depreciation categories",
    description: "Every category in the bundled Polish KST, UK capital allowance and US MACRS tables, with its rate, its provenance and what each table leaves out.",
    mimeType: "application/json",
}, async (uri) => ({
    contents: [{
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({
                schemes: SCHEMES,
                tables: TABLE_IDS.map((id) => {
                    const t = table(id);
                    return {
                        table: id, header: t.header, declining_coefficient_max: t.declining_coefficient_max,
                        count: t.rates.length,
                        rates: t.rates.map((r) => ({ code: r.code, name_en: r.name_en, name_pl: r.name_pl, rate_pct: r.rate_pct, percentages: r.percentages, declining_allowed: r.declining_allowed, note: r.note })),
                    };
                }),
                data_dir: dataDir(),
                home: home().how,
            }, null, 2),
        }],
}));
/* ------------------------------------------------------------------ prompt */
server.registerPrompt("depreciate_asset", {
    title: "Put an asset on the register",
    description: "Walk one purchase from the invoice to a stored asset, a schedule and this month's journal line.",
    argsSchema: { what: z.string().describe("What was bought, e.g. a MacBook Pro for 8,499 PLN on 12 March") },
}, ({ what }) => ({
    messages: [{
            role: "user",
            content: {
                type: "text",
                text: [
                    `I bought: ${what}.`,
                    "1. Read the assets://categories resource and tell me which bundled category this falls in, with its code and rate.",
                    "2. Call asset_add with the cost in minor units and the purchase date. State the convention and the first charge month it reports back.",
                    "3. Call asset_schedule for it and show me the yearly rows, then confirm they sum to the depreciable base.",
                    "4. Call asset_journal for the current month and give me the debit and credit lines.",
                    "Use the tools for every number. Do not do the arithmetic yourself.",
                ].join("\n"),
            },
        }],
}));
/* ------------------------------------------------------------------- start */
const transport = new StdioServerTransport();
await server.connect(transport);
