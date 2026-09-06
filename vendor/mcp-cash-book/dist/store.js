import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonFile } from "@theluckystrike/mcp-invoice/lib";
export function dataDir() {
    const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
    const dir = join(base, "mcp-servers", "cash-book");
    mkdirSync(dir, { recursive: true });
    return dir;
}
export function lockPath() { return join(dataDir(), ".lock"); }
function read(file, empty) {
    return readJsonFile(join(dataDir(), file), empty);
}
/** Atomic: per-process temp name, then rename over the target. */
function write(file, value) {
    const p = join(dataDir(), file);
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, p);
}
export function getPeriods() { return read("periods.json", []); }
export function setPeriods(v) { write("periods.json", v); }
export function getCloses() { return read("closes.json", []); }
export function setCloses(v) { write("closes.json", v); }
/**
 * The key a built period is identified by: one period is one date range in one currency.
 * Rebuilding the same range does not allocate a second row and is never metered again,
 * because the meter is on distinct periods and not on repeated questions about one.
 */
export function periodKey(from, to, currency) {
    return `${from}|${to}|${currency.toUpperCase()}`;
}
/**
 * The name a built period is called by in an answer. The register keys on the same three
 * fields, so the id is derived and never stored: a stored id is a second name for the row
 * that can drift from the row it names.
 */
export function periodId(from, to, currency) {
    return `${from}..${to}/${currency.toUpperCase()}`;
}
export function findPeriod(list, key) {
    return list.find((p) => periodKey(p.from, p.to, p.currency) === key);
}
export function findClose(list, month, currency) {
    return list.find((c) => c.month === month && c.currency.toUpperCase() === currency.toUpperCase());
}
