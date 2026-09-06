import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const FILES = {
    "pl-kst": "pl-kst.json",
    "uk-capital-allowances": "uk-capital-allowances.json",
    "us-macrs": "us-macrs.json",
};
export const SCHEMES = ["pl", "uk", "us"];
export const TABLE_IDS = Object.keys(FILES);
const SCHEME_TABLE = {
    pl: "pl-kst",
    uk: "uk-capital-allowances",
    us: "us-macrs",
};
const cache = new Map();
export function table(id) {
    const hit = cache.get(id);
    if (hit)
        return hit;
    const path = fileURLToPath(new URL(`./tables/${FILES[id]}`, import.meta.url));
    const t = JSON.parse(readFileSync(path, "utf8"));
    cache.set(id, t);
    return t;
}
export function schemeTable(scheme) {
    return table(SCHEME_TABLE[scheme]);
}
export function tableIdFor(scheme) {
    return SCHEME_TABLE[scheme];
}
/**
 * Resolve a category to a table row: exact code, then exact English or Polish name, then
 * a PREFIX of the name. Never a substring. `"land".includes("and")` is true, and a
 * substring fallback would silently price a piece of equipment at the land row's 0
 * percent and say nothing about it.
 */
export function findRate(scheme, category) {
    const rows = schemeTable(scheme).rates;
    const needle = String(category).trim().toLowerCase();
    if (!needle)
        return undefined;
    const exactCode = rows.find((r) => r.code.toLowerCase() === needle);
    if (exactCode)
        return exactCode;
    const exactName = rows.find((r) => r.name_en.toLowerCase() === needle || (r.name_pl ?? "").toLowerCase() === needle);
    if (exactName)
        return exactName;
    if (needle.length < 4)
        return undefined;
    const prefix = rows.filter((r) => r.name_en.toLowerCase().startsWith(needle) || (r.name_pl ?? "").toLowerCase().startsWith(needle));
    return prefix.length === 1 ? prefix[0] : undefined;
}
/**
 * ISO 4217 minor-unit counts for the currencies these tables name plus the common
 * zero-decimal ones. A wrong decimal count turns JPY 7,532 into JPY 75.32 in silence, so
 * the set is explicit rather than assumed.
 */
const ZERO_DECIMAL = new Set(["JPY", "KRW", "CLP", "ISK", "VND", "XOF", "XAF", "XPF", "HUF"]);
export function currencyDecimals(code) {
    return ZERO_DECIMAL.has(code.toUpperCase()) ? 0 : 2;
}
export function formatMoney(minor, code) {
    const d = currencyDecimals(code);
    const neg = minor < 0;
    const abs = Math.abs(Math.round(minor));
    if (d === 0)
        return `${code} ${neg ? "-" : ""}${abs.toLocaleString("en-US")}`;
    const unit = Math.floor(abs / 10 ** d);
    const frac = String(abs % 10 ** d).padStart(d, "0");
    return `${code} ${neg ? "-" : ""}${unit.toLocaleString("en-US")}.${frac}`;
}
