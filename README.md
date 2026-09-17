# mcp-petty-cash

<!-- mirror-seo:start -->

**MCP server for a petty cash book and voucher ledger: a cash float on the imprest system.** A petty cash float on the imprest system, reconciled to the minor unit.

Works with Claude Desktop, Claude Code, Cursor and any Model Context Protocol client. Runs on your own machine, or hosted with no install.

## Install

**Hosted, nothing to install.** Get a token from <https://mcp.zovo.one/mcp/connect> (the connect page) or <https://mcp.zovo.one/mcp/token> (the same token as JSON); a free anonymous one is issued on the spot and a Pro key works the same way. Then point an MCP client at `https://mcp.zovo.one/mcp/petty-cash` over streamable-http and send the token as `Authorization: Bearer <token>`.

If your client cannot set headers, put the token in the path instead: `https://mcp.zovo.one/mcp/petty-cash/t/<token>`. Both forms work. The bare URL with no token answers 401 on `tools/call`, so the token is not optional.

**Claude Desktop, one click.** Download `petty-cash.mcpb` from the [latest release](https://github.com/theluckystrike/mcp-servers/releases/latest) and double-click it.

**From source.** The mirror is self-contained: every `@theluckystrike/*` dependency is vendored, so a fresh clone builds with no extra setup.

```sh
git clone https://github.com/theluckystrike/mcp-petty-cash.git
cd mcp-petty-cash
npm install && npm run build
```

Then point your client at the built entry point:

```json
{
  "mcpServers": {
    "petty-cash": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-petty-cash/dist/index.js"]
    }
  }
}
```

> `@theluckystrike/mcp-petty-cash` is **not published on npm yet**, so an `npx -y @theluckystrike/mcp-petty-cash` command will fail. The three paths above are the working ones and each is exercised by CI.

![petty-cash demo](https://raw.githubusercontent.com/theluckystrike/mcp-servers/main/assets/demo-petty-cash.gif)

Read-only mirror of [mcp-servers/servers/petty-cash](https://github.com/theluckystrike/mcp-servers/tree/main/servers/petty-cash). See [MIRROR.md](MIRROR.md).

<!-- mirror-seo:end -->

**In the [official MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.theluckystrike%2Fpetty-cash/versions/latest)** (`io.github.theluckystrike/petty-cash`).
A petty cash float, kept the way the paperwork keeps it. Open a tin with an imprest amount and a custodian, record a voucher for every receipt that comes out of it, count the cash whenever you like, and get the difference to the minor unit along with the list of vouchers that count covers. When the tin runs low it works out the replenishment: what the cheque has to be to put the float back to its imprest, which vouchers it reimburses, the totals per category as an `expense_add`-ready payload, and the double entry in the cash book's own account names. Every amount is an integer number of minor units, no balance is ever stored, and nothing is posted anywhere: the payload is handed back for whoever owns the books.

Built by theluckystrike.

npm publish for `@theluckystrike/mcp-petty-cash` is pending, so `npx -y @theluckystrike/mcp-petty-cash` returns 404 today. Until then, the `.mcpb` one-click bundle or a clone+build is the working path.

## Install

### Claude Desktop

macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "petty-cash": {
      "command": "npx",
      "args": ["-y", "@theluckystrike/mcp-petty-cash"]
    }
  }
}
```

### Claude Code

```sh
claude mcp add petty-cash -- npx -y @theluckystrike/mcp-petty-cash
```

### Cursor

`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project), same entry as Claude Desktop.

## Tools

| tool | what it does |
| --- | --- |
| `float_open` | Open a float on the imprest system: name, currency, imprest amount in minor units, custodian. Returns `FLOAT-YYYY-NNNN` and the opening journal |
| `topup_record` | Record cash going into the tin: amount, date, source. Marks every voucher up to that date reimbursed |
| `voucher_add` | Record one voucher out of the tin: amount, date, category, description, payee, receipt reference. Returns `VOU-YYYY-NNNN` |
| `voucher_delete` | Delete a voucher entered wrongly, while it is still uncounted |
| `reconcile` | Count the cash: the expected balance, the difference, the vouchers since the last count, all marked reconciled, and the count recorded |
| `replenish_request` | What restores the imprest: the amount, the vouchers it covers, the per-category `expense_add` payload and the double entry. Writes nothing |
| `float_report` | Balance against imprest, unreconciled vouchers, the last count, and the history of every difference a count found |
| `license_status` / `license_activate` | Free or Pro, and the key |

## Free vs Pro

| | Free | Pro |
| --- | --- | --- |
| Floats open | 1 | Unlimited |
| Vouchers a calendar month | 20 | Unlimited |
| Reconciliation (`reconcile`) | Unlimited | Unlimited |
| Delete a voucher (`voucher_delete`) | Yes | Yes |
| Record a top-up (`topup_record`) | Yes | Yes |
| Replenishment (`replenish_request`) | - | Yes |
| Report (`float_report`) | - | Yes |

The count is never metered. Whether the cash in the tin matches the paperwork is the question this server exists to answer, and a free tier that withholds the answer is a demo. What is metered is the volume of record keeping: a second float is a second tin, and twenty vouchers a month is a real one-tin office. `voucher_delete` is free for the same reason the cap is on records held: a voucher typed in twice would otherwise cost a slot with no way back but a key.

**Get Pro:** https://mcp.zovo.one/buy/petty-cash -- $19 one-time for this server, or $39 for the bundle.

## A measured insight

**The cheque is not the sum of the vouchers, and the gap is invisible in the voucher trail.**

The worked month in `test/unit.test.mjs`: a EUR 500.00 imprest, five vouchers totalling 20,194 minor units, so the paperwork says the tin holds 29,806 on the 31st. It holds 29,795. The count is short by exactly 11 minor units, eleven cents that no voucher explains and no receipt will ever be found for.

The replenishment is then 20,205, not 20,194. Reimbursing the voucher total instead is the natural thing to do, it is what the vouchers add up to, and it restores the float 11 short. The same suite runs three cycles of that: the float ends at 49,967 against a 50,000 imprest, 33 minor units light, and every one of the three reconciliations in between reported a difference of exactly 11 and nothing worse. Nothing ever looks broken. The tin just gets smaller.

That is why `replenish_request` computes `imprest - balance` and never `sum(vouchers)`, and why the difference comes back as its own `cash_over_short` journal line rather than being folded into an expense category where it would look like postage.

## Privacy

All data stays local, in `${XDG_DATA_HOME:-~/.local/share}/mcp-servers/petty-cash/`. Three files: `floats.json`, `vouchers.json`, `counter.json`. Nothing is sent anywhere, there is no account, no API key and no network call in this server at all. License keys are verified offline. The journal and the `expense_add` payload are returned to you; this server posts nothing into any other store.

Built by theluckystrike. https://github.com/theluckystrike
