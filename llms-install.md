# Installing mcp-petty-cash (agent instructions)

This file tells an AI coding agent exactly how to install this MCP server. No account, no API key, no network service is required.

Server: **Petty cash** (@theluckystrike/mcp-petty-cash)
What it does: Keep a petty cash float on the imprest system. Open a tin with an imprest amount and a custodian, record a voucher for every receipt paid out of it, count the cash and reconcile to the minor unit, and raise the replenishment that restores the imprest, with the double entry and an `expense_add`-ready payload per category. No balance is stored; every balance is derived from the imprest, the top-ups, the vouchers and what each count found.
Source: https://github.com/theluckystrike/mcp-servers/tree/main/servers/petty-cash
License: MIT. Support: support@zovo.one

## Status of the npm package

The npm package `@theluckystrike/mcp-petty-cash` is not published yet. Until it is, the `npx` command below will fail with E404. Use **Alternative B - from source** further down, which is the supported path today, and keep the same client config with `"command": "node"` and the absolute path to `dist/index.js`. Everything else on this page is unchanged.

## Prerequisites

- Node.js 18 or newer on PATH (`node --version`).
- No native dependencies. The package is pure JavaScript.
- No sibling server is required at runtime. This one reads no other server's store and writes into none. It does read the shared business profile for the custodian name, which the invoice server's `business_set` writes.

## Step 1 - the run command

```sh
npx -y @theluckystrike/mcp-petty-cash
```

The server speaks MCP over stdio. It writes nothing to stdout except protocol traffic. Do not run it interactively as a check; the client starts it.

## Step 2 - write the client config

### Claude Desktop

File: macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows `%APPDATA%\Claude\claude_desktop_config.json`.
Merge this entry into the existing `mcpServers` object; do not overwrite the file.

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

File: `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project). Same entry as Claude Desktop.

### Cline

File: `cline_mcp_settings.json` (VS Code: Cline panel -> MCP Servers -> Configure MCP Servers). Merge:

```json
{
  "mcpServers": {
    "petty-cash": {
      "command": "npx",
      "args": ["-y", "@theluckystrike/mcp-petty-cash"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

## Step 3 - restart the client and verify

Restart the client, then call `license_status`. A successful call returns the current mode (free or pro) and proves the transport works. Then read the `pettycash://accounts` resource: it lists the account ids a float touches and the one directory this server writes. Then run the worked check: `float_open` with `imprest_minor` 50000 and currency EUR, five vouchers totalling 20194 minor units, and `reconcile` with `counted_minor` 29795. The answer must be `expected_minor` 29806 and `difference_minor` -11. `tools/list` must show the nine tools from the server README.

## Optional - Pro key

A Pro key removes the free-tier limits listed in the README. Either add it to the config:

```json
"env": { "MCP_LICENSE_KEY": "MCPL1..." }
```

or call the `license_activate` tool once with the key. Keys are verified offline; nothing is sent anywhere. Keys: https://mcp.zovo.one/buy/petty-cash

## Alternative A - .mcpb bundle (Claude Desktop one-click)

Download `petty-cash.mcpb` from https://github.com/theluckystrike/mcp-servers/releases and open it, or drag it onto the Claude Desktop Extensions pane. This installs the server without editing JSON and without Node on PATH assumptions.

## Alternative B - from source

```sh
git clone https://github.com/theluckystrike/mcp-servers
cd mcp-servers
npm install
npm run build --workspaces --if-present
```

The chart of accounts is imported from `mcp-cash-book`, the money formatting from `mcp-asset-register`, the corrupt-store quarantine from `mcp-timezone` and the timezone-aware "today" from `mcp-quotes`, so build the workspaces before this server rather than this server alone.
Then use `"command": "node", "args": ["<abs path>/mcp-servers/servers/petty-cash/dist/index.js"]`.

## Alternative C - Docker

```sh
docker buildx build -f servers/petty-cash/Dockerfile -t mcp-petty-cash .
```

The build context is the repository root. Run with `docker run -i --rm -v mcp-servers-data:/root/.local/share/mcp-servers mcp-petty-cash`.

## Troubleshooting

- `command not found: npx` - install Node.js 18+.
- Tools missing after config edit - the client only reads the config at startup; restart it fully.
- `"the free tier holds 1 float"` - vouchers, counting and deletion on that float stay free. Activate a Pro key for a second tin.
- `"the free tier records 20 vouchers a calendar month"` - `reconcile` and `voucher_delete` stay free, so the tin can still be counted and corrected.
- `"the float held EUR ... and the voucher is EUR ..."` - a float is cash in a tin and cannot pay out more than it holds. Record the top-up that funded the spend first, dated on or before the voucher.
- `"is already this voucher, to the byte"` - the same float, date, amount, category, description, payee and receipt reference is already recorded. Pass `duplicate_ok: true` if the same thing really was bought twice.
- `"was reconciled on ... and cannot be deleted"` - the cash it took out was counted that day. Record a correcting voucher, or count the tin again.
- The replenishment is larger than the vouchers - that is correct. The amount restores the imprest, and it differs from the voucher total by exactly what the counts found short. The gap comes back as a `cash_over_short` journal line.
- Data location: this server writes only `${XDG_DATA_HOME:-~/.local/share}/mcp-servers/petty-cash/floats.json`, `vouchers.json` and `counter.json`, and nothing else anywhere. The journal and the `expense_add` payload are for whoever owns the books; nothing is posted from here.

Built by theluckystrike (https://github.com/theluckystrike).
