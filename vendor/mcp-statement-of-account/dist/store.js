import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonFile } from "@theluckystrike/mcp-invoice/lib";
export function dataDir() {
    const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
    const dir = join(base, "mcp-servers", "statement-of-account");
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
export function getStatements() { return read("statements.json", []); }
export function setStatements(v) { write("statements.json", v); }
/**
 * The key a statement is identified by. A statement is one client, one currency and one
 * period, so re-rendering the same three values updates the row it already has rather
 * than allocating a second id: a client who asks for the September statement twice has
 * one September statement, and the free tier must not charge for the second look.
 */
export function statementKey(clientName, from, to, currency) {
    return `${clientName.trim().toLowerCase()}|${from}|${to}|${currency.toUpperCase()}`;
}
export function findStatement(list, key) {
    return list.find((s) => statementKey(s.client_name, s.from, s.to, s.currency) === key);
}
/**
 * Allocate the next statement id: `STMT-<YYYY>-<NNNN>`.
 *
 * The counter is per year and is written BEFORE the record is stored, so a crash burns
 * an id rather than reusing one. Ids already in the register are also scanned, so a
 * restored or hand-edited register cannot reissue a number that is already on a
 * statement sitting in a client's inbox.
 */
export function nextStatementId(year, existing) {
    const counters = read("counter.json", {});
    const key = `STMT-${year}`;
    let n = counters[key] ?? 0;
    const used = new Set(existing);
    do {
        n += 1;
    } while (used.has(`${key}-${String(n).padStart(4, "0")}`));
    counters[key] = n;
    write("counter.json", counters);
    return `${key}-${String(n).padStart(4, "0")}`;
}
