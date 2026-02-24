# WhatsApp MCP Server (TypeScript/Baileys)

[![smithery badge](https://smithery.ai/badge/@jlucaso1/whatsapp-mcp-ts)](https://smithery.ai/server/@jlucaso1/whatsapp-mcp-ts)

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that connects your personal WhatsApp account to AI agents like Claude, Cursor, or any MCP-compatible client.

Send and receive messages, search contacts, browse chat history, share media — all through natural language commands in your AI assistant.

## What Can It Do?

- **Send & receive messages** — text, images, videos, documents, audio
- **Search contacts & groups** — case-insensitive, works by name or phone number
- **Browse chat history** — paginated, sortable, filterable
- **Reply & react** — quoted replies and emoji reactions
- **Group support** — send to groups, list group members
- **Message search** — full-text search across all chats
- **Mark as read** — mark chats as read
- **Sync contacts** — pull latest contact names from WhatsApp

## Quick Start

### Prerequisites

- **Node.js 23.10.0+** — required for built-in SQLite support ([download](https://nodejs.org/))
  ```bash
  node -v  # must be >= 23.10.0
  ```
- **A WhatsApp account** on your phone
- **An MCP-compatible AI client** — Claude Desktop, Claude Code, Cursor, Cline, or Roo Code

### 1. Clone & Install

```bash
git clone https://github.com/nickshu/whatsapp-mcp-ts.git
cd whatsapp-mcp-ts
npm install
```

### 2. Link Your WhatsApp

Run the server directly to perform initial setup:

```bash
node src/main.ts
```

This will:
1. Generate a **QR code link** (opens automatically in your browser via `quickchart.io`)
2. On your phone: open **WhatsApp → Settings → Linked Devices → Link a Device**
3. Scan the QR code with your phone
4. Wait for message history to sync (can take a few minutes for large accounts)

Your credentials are saved to `./auth_info/` — you won't need to scan again unless you log out.

> **Tip:** Check `wa-logs.txt` for sync progress. Once you see messages being stored, you're good to go.

### 3. Connect to Your AI Client

Add the server to your AI client's MCP configuration. Replace `<PATH>` with the absolute path to this repo.

#### Claude Desktop

Edit your config file:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": ["<PATH>/src/main.ts"]
    }
  }
}
```

#### Claude Code

Edit `~/.claude.json` (global) or your project's `.claude/mcp.json`:

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": ["--import", "tsx/esm", "<PATH>/src/main.ts"]
    }
  }
}
```

> **Note:** Claude Code requires `tsx` for TypeScript. Make sure `tsx` is installed (`npm install -g tsx` or use the project's local copy).

#### Cursor

Edit `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": ["<PATH>/src/main.ts"]
    }
  }
}
```

#### Smithery (Auto-Install)

```bash
npx -y @smithery/cli install @jlucaso1/whatsapp-mcp-ts --client claude
```

### 4. Restart Your AI Client

Close and reopen your AI client. The WhatsApp MCP tools should now be available.

## Available MCP Tools

| Tool | Description |
|---|---|
| `send_message` | Send a text message. Accepts contact name, phone number, or JID as recipient. |
| `send_media` | Send an image, video, document, or audio file. Auto-detects MIME type. |
| `reply_to_message` | Send a quoted reply to a specific message. |
| `send_reaction` | React to a message with an emoji (or remove reaction with empty string). |
| `search_contacts` | Search contacts by name or phone number. |
| `list_chats` | List chats with sorting, filtering, and pagination. |
| `get_chat` | Get details about a specific chat. |
| `list_messages` | Get message history for a chat (paginated). |
| `get_message_context` | Get messages before and after a specific message. |
| `search_messages` | Full-text search across messages, optionally scoped to a chat. |
| `get_group_members` | List members of a WhatsApp group. |
| `mark_as_read` | Mark a chat as read. |
| `sync_contacts` | Manually sync contact names from WhatsApp. |

### Smart Recipient Resolution

When using `send_message` or `send_media`, you don't need to know JIDs. The server resolves recipients automatically:

```
"Dady"          → searches contacts by name (case-insensitive)
"Family"        → searches groups by name (case-insensitive)
"+91 99190 03141" → converts phone number to JID
"919919003141@s.whatsapp.net" → uses JID directly
```

If multiple matches are found, you'll get a list to choose from.

## Example Usage

**You:** Send a message to Dady saying "Good morning!"

**AI Agent:**
1. Resolves "Dady" → `919919003141@s.whatsapp.net`
2. Sends "Good morning!" to that JID
3. Returns: `Message sent successfully (ID: 3EB0...)`

**You:** Send my resume to the Family group

**AI Agent:**
1. Resolves "Family" → finds "Family ❤️" group
2. Sends the PDF via `send_media`
3. Returns: `Media sent successfully`

## Architecture

```
┌──────────────────────────────────┐
│  AI Client (Claude / Cursor)     │
└──────────┬───────────────────────┘
           │ stdio (JSON-RPC)
┌──────────▼───────────────────────┐
│  MCP Server (src/mcp.ts)         │
│  13 tools · Zod validation       │
└─────┬────────────────┬───────────┘
      │                │
┌─────▼──────┐  ┌──────▼───────────┐
│  SQLite DB  │  │  Baileys Socket  │
│  (node:sql) │  │  (WhatsApp Web)  │
├────────────┤  ├──────────────────┤
│ messages   │  │ QR auth          │
│ chats      │  │ Send/receive     │
│ contacts   │  │ History sync     │
└────────────┘  └──────────────────┘
```

- **`src/main.ts`** — Entry point. Initializes DB, WhatsApp, and MCP server.
- **`src/mcp.ts`** — Defines all MCP tools and handles recipient resolution.
- **`src/whatsapp.ts`** — Baileys integration: authentication, sending, syncing.
- **`src/database.ts`** — SQLite schema, message/chat storage and queries.

## Data Storage & Privacy

| Directory | Contents | Sensitive? |
|---|---|---|
| `./auth_info/` | WhatsApp session credentials | Yes — treat as passwords |
| `./data/whatsapp.db` | All synced messages and chat metadata | Yes — contains personal messages |
| `./contacts.json` | Cached contact list (fallback for name resolution) | Moderate |
| `./groups.json` | Cached group list with JIDs | Moderate |

All sensitive directories are git-ignored. Your data stays local — it's only sent to the AI when a tool is explicitly invoked.

## Logs

Two log files are created at runtime:

- **`wa-logs.txt`** — WhatsApp connection events, QR codes, sync progress
- **`mcp-logs.txt`** — MCP tool invocations, errors, request details

Set the log level via environment variable:
```bash
LOG_LEVEL=debug node src/main.ts  # trace | debug | info | warn | error
```

## Troubleshooting

### QR code doesn't appear
Check `wa-logs.txt` for the `quickchart.io` URL and open it manually in your browser.

### "Logged out" or authentication errors
Delete `./auth_info/` and restart the server to get a fresh QR code:
```bash
rm -rf auth_info/
node src/main.ts
```

### Messages not syncing
Initial sync can take several minutes for accounts with large histories. Check `wa-logs.txt` for progress. If messages seem stuck, do a full reset:
```bash
rm -rf auth_info/ data/
node src/main.ts
```

### MCP tools not showing up in AI client
1. Verify the path in your config is **absolute** (not relative)
2. Ensure Node.js 23.10.0+ is in your system PATH
3. Restart the AI client completely (not just reload)
4. Check `mcp-logs.txt` for startup errors

### "No contact or group found"
The name search is case-insensitive but partial — try a more specific name, or use a phone number or JID directly.

### Group messages failing with 406 error
This can happen with groups where all members use LID-based accounts. The server retries automatically after 2 seconds. If it persists, ensure you're on Baileys v7.0.0-rc.9+.

### Server running old code after changes
If you're developing and the server doesn't pick up code changes, kill all node processes and restart:
```bash
# Find and kill stale processes
tasklist | findstr node        # Windows
ps aux | grep node             # macOS/Linux

# Then restart your AI client
```

## Docker

```bash
docker build -t whatsapp-mcp .
docker run -it whatsapp-mcp
```

Note: You'll need to handle QR code scanning during the initial setup. Mount volumes for `auth_info/` and `data/` to persist sessions:
```bash
docker run -it -v ./auth_info:/app/auth_info -v ./data:/app/data whatsapp-mcp
```

## Tech Stack

- **TypeScript** with ES Modules
- **Node.js 23.10+** (built-in SQLite via `node:sqlite`)
- **[@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys)** v7 — WhatsApp Web API
- **[@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)** — MCP server framework
- **Zod** — input validation
- **Pino** — structured logging

## Credits

- [whatsapp-mcp](https://github.com/lharries/whatsapp-mcp) — The original Go/Python implementation that inspired this project.

## License

ISC
# elMCP
