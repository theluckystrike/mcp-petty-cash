import { currencyDecimals, findRate, formatMoney, schemeTable, tableIdFor } from "./tables.js";
/**
 * The depreciation engine. Three rules live here and nothing else does.
 *
 * 1. Money is integer minor units end to end. Every rate is applied to a float, but the
 *    float never leaves this file: the raw per-period amounts are handed to `allocate`,
 *    which converts them to minor units by CUMULATIVE rounding and makes the last period
 *    absorb the remainder, so the schedule sums to the depreciable base to the cent by
 *    construction rather than by luck. A schedule that is a cent short of the base is a
 *    trial balance that does not balance.
 *
 * 2. The convention is the table's, not the caller's. Poland starts in the month AFTER
 *    the asset enters the register (art. 16h ust. 1 pkt 1), the US GDS tables already
 *    carry the half-year convention inside the published percentages, and a UK writing
 *    down allowance is a full-period allowance on a pool. Every answer names the
 *    convention it used.
 *
 * 3. Nothing is invented. Where a scheme has no statutory concept for something the tool
 *    is asked for -- a useful life for a UK pool, a salvage value under MACRS -- the
 *    answer says the value was derived or ignored, in words, rather than presenting it as
 *    a rate someone published.
 */
export const MAX_PERIODS = 120;
/**
 * A UK writing down allowance is a pure reducing balance: it never reaches zero. The
 * schedule is cut at 25 periods and the last one writes off what is left, with the basis
 * line saying so, rather than printing a hundred rows that each shave a penny.
 */
export const UK_POOL_PERIODS = 25;
export const MAX_MINOR = 1e14;
export const METHODS = ["straight-line", "declining-balance"];
/* ------------------------------------------------------------------- dates */
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;
export function parseDate(value, field) {
    const s = String(value).trim();
    if (!DATE.test(s))
        throw new Error(`${field} must be an ISO calendar date YYYY-MM-DD, got "${value}"`);
    const [y, m, d] = s.split("-").map(Number);
    if (m < 1 || m > 12)
        throw new Error(`${field} has month ${m}`);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    if (d < 1 || d > last)
        throw new Error(`${field} has day ${d}, but ${s.slice(0, 7)} has ${last} days`);
    return { y, m, d };
}
export function monthKey(y, m) {
    return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
}
export function parseMonth(value, field) {
    const s = String(value).trim();
    if (MONTH.test(s)) {
        const [y, m] = s.split("-").map(Number);
        if (m >= 1 && m <= 12)
            return { y, m };
    }
    if (DATE.test(s)) {
        const p = parseDate(s, field);
        return { y: p.y, m: p.m };
    }
    throw new Error(`${field} must be a month YYYY-MM, got "${value}"`);
}
/** Month index since year 0, so month arithmetic never crosses a year boundary by hand. */
const abs = (y, m) => y * 12 + (m - 1);
/* --------------------------------------------------------------- allocation */
/**
 * Convert raw float amounts to integer minor units so that they sum EXACTLY to `base`.
 *
 * Rounding each period independently and hoping the total lands on the base is the usual
 * defect: eight periods each half a cent out is four cents of unexplained difference on
 * the balance sheet. Here the CUMULATIVE total is rounded at each step and the period
 * amount is the difference between two rounded cumulatives, and the final period is set
 * to whatever is left, so the identity sum(periods) == base holds for every input.
 */
export function allocate(base, raws) {
    const total = raws.reduce((a, b) => a + b, 0);
    if (raws.length === 0)
        return [];
    if (total <= 0)
        return raws.map(() => 0);
    const out = [];
    let prevCum = 0;
    let running = 0;
    for (let i = 0; i < raws.length; i++) {
        running += raws[i];
        const cum = i === raws.length - 1 ? base : Math.round((base * running) / total);
        out.push(cum - prevCum);
        prevCum = cum;
    }
    return out;
}
/* ---------------------------------------------------------------- schedule */
export function buildSchedule(input) {
    const t = schemeTable(input.scheme);
    const row = findRate(input.scheme, input.category);
    if (!row) {
        const codes = t.rates.map((r) => r.code).join(", ");
        throw new Error(`"${input.category}" is not a category in the bundled ${input.scheme.toUpperCase()} table. ` +
            `${t.header.coverage ?? ""} Read the assets://categories resource for the full list. Codes: ${codes}`);
    }
    if (!Number.isInteger(input.cost_minor))
        throw new Error("cost must be whole minor units (integer cents)");
    if (input.cost_minor <= 0)
        throw new Error(`cost must be greater than zero, got ${input.cost_minor} minor units`);
    if (input.cost_minor > MAX_MINOR)
        throw new Error(`cost is over the ${MAX_MINOR} minor unit ceiling`);
    if (!Number.isInteger(input.residual_minor) || input.residual_minor < 0)
        throw new Error("residual must be a whole number of minor units, zero or more");
    if (input.residual_minor >= input.cost_minor) {
        throw new Error(`residual ${input.residual_minor} is not less than cost ${input.cost_minor} minor units. ` +
            `There would be nothing to depreciate, so nothing was written.`);
    }
    const purchase = parseDate(input.purchase_date, "purchase_date");
    const inService = parseDate(input.in_service_date, "in_service_date");
    if (abs(inService.y, inService.m) * 100 + inService.d < abs(purchase.y, purchase.m) * 100 + purchase.d) {
        throw new Error(`in_service_date ${input.in_service_date} is before purchase_date ${input.purchase_date}`);
    }
    const notes = [];
    // Residual. MACRS recovers the whole cost and ignores salvage; saying so beats applying it.
    let residual = input.residual_minor;
    if (input.scheme === "us" && residual > 0) {
        notes.push(`MACRS ignores salvage value: the published GDS percentages recover the full cost. The residual of ${formatMoney(residual, input.currency)} was NOT applied and the schedule runs to zero. It is kept on the asset record for book purposes.`);
        residual = 0;
    }
    const base = input.cost_minor - residual;
    // Rate and life.
    const overrideLife = input.life_years;
    if (overrideLife !== undefined && (!Number.isFinite(overrideLife) || overrideLife <= 0)) {
        throw new Error(`life_years must be greater than zero, got ${overrideLife}. A life of zero would divide the cost by nothing.`);
    }
    let rate;
    let life;
    let lifeSource;
    if (overrideLife !== undefined) {
        life = overrideLife;
        rate = 100 / life;
        lifeSource = `useful life ${life} years was passed on the call and overrides the table`;
    }
    else if (input.rate_pct !== undefined) {
        rate = input.rate_pct;
        life = rate > 0 ? 100 / rate : 0;
        lifeSource = `rate ${rate} percent was passed on the call and overrides the table`;
    }
    else if (row.percentages) {
        life = row.life_years ?? row.percentages.length;
        rate = 100 / life;
        lifeSource = `useful life ${life} years is the ${row.code} GDS class of the bundled IRS table`;
    }
    else {
        rate = row.rate_pct ?? 0;
        life = rate > 0 ? 100 / rate : 0;
        lifeSource = input.scheme === "uk"
            ? `a UK writing down allowance is a pool rate with no statutory useful life; ${rate} percent reducing balance never reaches zero, so the life shown is DERIVED as the number of periods this schedule runs`
            : `useful life ${(100 / rate).toFixed(2)} years is derived as 100 divided by the annex rate of ${rate} percent for KST ${row.code}`;
    }
    if (input.rate_pct !== undefined && (!Number.isFinite(input.rate_pct) || input.rate_pct <= 0 || input.rate_pct > 100)) {
        throw new Error(`rate_pct must be greater than zero and at most 100, got ${input.rate_pct}`);
    }
    if (rate <= 0) {
        throw new Error(`"${row.name_en}" (${row.code}) carries a rate of 0 percent in the bundled ${input.scheme.toUpperCase()} table and is not depreciated. ` +
            `${row.note ?? ""} Pass life_years or rate_pct explicitly if this is a book schedule rather than a tax one.`);
    }
    // Method.
    let method = input.method;
    let coefficient;
    if (method === "declining-balance") {
        if (row.declining_allowed === false) {
            throw new Error(`"${row.name_en}" (${row.code}) may not use the declining-balance method under the bundled ${input.scheme.toUpperCase()} rules. ${row.note ?? ""} Use method "straight-line".`);
        }
        coefficient = input.declining_coefficient ?? (input.scheme === "pl" ? (t.declining_coefficient_max ?? 2) : 1);
        if (!Number.isFinite(coefficient) || coefficient <= 0)
            throw new Error(`declining_coefficient must be greater than zero, got ${coefficient}`);
        const max = t.declining_coefficient_max;
        if (max !== undefined && coefficient > max) {
            throw new Error(`declining_coefficient ${coefficient} is over the ${max} the bundled ${input.scheme.toUpperCase()} table allows`);
        }
    }
    else if (input.declining_coefficient !== undefined) {
        notes.push("declining_coefficient was given with method straight-line and was ignored.");
    }
    const convention = t.header.convention;
    // First charge month.
    let startY = inService.y;
    let startM = inService.m;
    if (convention === "pl-month-following") {
        startM += 1;
        if (startM > 12) {
            startM = 1;
            startY += 1;
        }
        notes.push(`Poland charges from the month AFTER the asset enters the register (art. 16h ust. 1 pkt 1), so the first charge is ${monthKey(startY, startM)}, not ${monthKey(inService.y, inService.m)}.`);
    }
    else if (convention === "us-half-year") {
        notes.push("The half-year convention is already inside the published GDS percentages: year one carries half a year and the schedule runs one year past the class life. The mid-quarter convention is not bundled and was not chosen for you.");
    }
    else {
        notes.push("A UK writing down allowance is a full-period allowance on a pool, not a per-asset monthly charge; it is not prorated by month of purchase. This schedule applies the pool rate to one asset so a per-asset figure exists; the tax computation is still made on the pool.");
    }
    // Raw per-period amounts, in float, never leaving this function.
    const usePublished = Boolean(row.percentages) && overrideLife === undefined && input.rate_pct === undefined;
    if (row.percentages && !usePublished) {
        notes.push(`The published ${row.code} GDS percentages were NOT used because a life or rate was passed on the call. The schedule is a plain ${method} computation instead.`);
    }
    const firstYearMonths = convention === "pl-month-following" ? 12 - startM + 1 : 12;
    const linear = base * (rate / 100);
    const raws = [];
    const bases = [];
    let remaining = base;
    let switched = false;
    const limit = input.scheme === "uk" && method === "declining-balance" ? UK_POOL_PERIODS : MAX_PERIODS;
    for (let i = 0; i < limit && remaining > 0.000001; i++) {
        const months = i === 0 ? firstYearMonths : 12;
        let amount;
        let basis;
        if (usePublished && row.percentages) {
            if (i >= row.percentages.length)
                break;
            amount = input.cost_minor * (row.percentages[i] / 100);
            basis = `IRS Pub 946 Table A-1, ${row.code} half-year, year ${i + 1}: ${row.percentages[i]} percent of cost`;
        }
        else if (method === "straight-line") {
            amount = linear * (months / 12);
            basis = months === 12
                ? `${rate} percent of the depreciable base`
                : `${rate} percent of the depreciable base for ${months} of 12 months`;
        }
        else {
            const db = remaining * ((rate * (coefficient ?? 1)) / 100) * (months / 12);
            const sl = linear * (months / 12);
            if (input.scheme === "pl" && !switched && db < sl)
                switched = true;
            if (input.scheme === "pl" && switched) {
                amount = sl;
                basis = `art. 16k: the declining amount fell below the straight-line one, so the rest of the schedule is straight line at ${rate} percent`;
            }
            else {
                amount = db;
                basis = `${rate} percent times ${coefficient} on the opening written-down value` + (months === 12 ? "" : ` for ${months} of 12 months`);
            }
            // A pure reducing balance never reaches zero. The last period this loop will run
            // takes the balance down rather than leaving a stub that never closes.
            if (i === limit - 1) {
                amount = remaining;
                basis = `final period: the written-down value is taken to ${residual > 0 ? "the residual" : "zero"} rather than left as a balance a reducing rate can never close`;
            }
        }
        if (amount > remaining || remaining - amount < 0.005) {
            amount = remaining;
        }
        raws.push(amount);
        bases.push(basis);
        remaining -= amount;
    }
    if (raws.length === 0)
        throw new Error("the inputs produce no depreciation periods at all; nothing was written");
    if (remaining > 0.005) {
        // Reducing balance that ran out of periods: close it on the last one.
        raws[raws.length - 1] += remaining;
        bases[bases.length - 1] = `final period: the remaining written-down value is written off here, at the ${limit} period ceiling this server puts on one schedule`;
    }
    const amounts = allocate(base, raws);
    const periods = [];
    let opening = input.cost_minor;
    for (let i = 0; i < amounts.length; i++) {
        const year = startY + i;
        const from = i === 0 ? startM : 1;
        const to = 12;
        const months = [];
        for (let m = from; m <= to; m++)
            months.push(monthKey(year, m));
        const closing = opening - amounts[i];
        periods.push({
            index: i + 1, year, months,
            opening_minor: opening, amount_minor: amounts[i],
            amount: formatMoney(amounts[i], input.currency),
            closing_minor: closing, basis: bases[i],
        });
        opening = closing;
    }
    if (input.scheme === "uk" && overrideLife === undefined && input.rate_pct === undefined && row.code !== "aia") {
        life = periods.length;
    }
    const total = amounts.reduce((a, b) => a + b, 0);
    return {
        scheme: input.scheme,
        table: tableIdFor(input.scheme),
        category: row,
        method,
        convention,
        currency: input.currency,
        cost_minor: input.cost_minor,
        residual_applied_minor: residual,
        depreciable_base_minor: base,
        rate_pct: rate,
        useful_life_years: Number(life.toFixed(4)),
        life_source: lifeSource,
        declining_coefficient: coefficient,
        in_service_date: input.in_service_date,
        first_charge_month: monthKey(startY, startM),
        periods,
        total_minor: total,
        total: formatMoney(total, input.currency),
        notes,
        source: {
            authority: t.header.authority,
            instrument: t.header.instrument,
            source_url: t.header.source_url,
            effective_date: t.header.effective_date,
            retrieved_date: t.header.retrieved_date,
        },
    };
}
/**
 * The monthly view. Each period's exact minor-unit amount is split across that period's
 * months by the same cumulative-rounding rule, so the months of a year sum to the year
 * and the years sum to the base. Nothing is re-derived from a float here.
 */
export function monthlyRows(s) {
    const out = [];
    for (const p of s.periods) {
        const per = allocate(p.amount_minor, p.months.map(() => 1));
        p.months.forEach((m, i) => out.push({ month: m, amount_minor: per[i], amount: formatMoney(per[i], s.currency), period: p.index }));
    }
    return out;
}
/** Accumulated depreciation charged up to and including `month`. */
export function accumulatedTo(s, month) {
    return monthlyRows(s).filter((r) => r.month <= month).reduce((a, r) => a + r.amount_minor, 0);
}
export function chargeForMonth(s, month) {
    return monthlyRows(s).filter((r) => r.month === month).reduce((a, r) => a + r.amount_minor, 0);
}
export { currencyDecimals, formatMoney };
