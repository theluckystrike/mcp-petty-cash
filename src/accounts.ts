/**
 * The accounts a petty cash float touches, named to match servers/cash-book.
 *
 * `cash` and the per-category `expenses:<category>` ids are IMPORTED from that server's
 * own ledger rather than retyped here, so a line journalled from this server lands in the
 * account its ledger already posts to and cannot drift from it. `petty_cash` and
 * `cash_over_short` are new: servers/cash-book derives no float entries yet and holds no
 * account for either. They follow its convention exactly, a snake_case id and a
 * sentence-case name, so that when it does derive them these are the ids it will use.
 */
import { CASH, accountFor, expenseAccount } from "@theluckystrike/mcp-cash-book/lib";

export { CASH, expenseAccount };

/** The float itself, an asset. Under the imprest system it sits at the imprest amount. */
export const PETTY_CASH = "petty_cash";
/** The difference a count found: an expense when the tin is short, negative when it is over. */
export const CASH_OVER_SHORT = "cash_over_short";

export const OWN_ACCOUNT_NAMES: Record<string, string> = {
  [PETTY_CASH]: "Petty cash",
  [CASH_OVER_SHORT]: "Cash over and short",
};

/** The cash book's name for an id, with this server's two additions. */
export function accountName(id: string): string {
  return OWN_ACCOUNT_NAMES[id] ?? accountFor(id).name;
}
