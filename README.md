# pi-hindsight 🧠

> A pi extension for cross-session memory: FTS5 + vector search, scratchpad, daily logs, and ambient context injection.

## Features

| Feature | Description |
|---------|-------------|
| **Memory Recall** | Hybrid FTS5 keyword + sqlite-vec vector ANN search with RRF fusion |
| **Tier-1 Capture** | Zero-LLM-cost heuristic extraction from assistant messages on `message_end` |
| **Scratchpad** | Todo list with `add`/`list`/`done`/`undo`/`clear` — model-managed |
| **Daily Logs** | Auto-append on session shutdown + manual `mem_daily` tool + `/mem-daily` command |
| **Session Handoff** | Compact-triggered handoff summary written to daily logs |
| **Ambient Injection** | Optional `PI_MEM_AMBIENT=1` mode injects daily log + key facts + open todos into system prompt |
| **Memory Export** | `mem_export` tool generates a Markdown report |

## Quick Start

### Install

Clone the repo and install dependencies:

```bash
git clone https://github.com/Sunrise521/pi-hindsight.git
cd pi-hindsight
npm install
```

### Register as a pi extension

Add to your pi settings or the extension will auto-register via `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

### Usage

Once loaded, the following tools are available to the model:

| Tool | Description |
|------|-------------|
| `recall_memory` | Search memories with `query`, `category`, `mode` (fts/vector/hybrid) |
| `mem_count` | Count memories by category |
| `scratch` | Manage scratchpad: `add`, `list`, `done`, `undo`, `clear` |
| `mem_daily` | Append to today's daily log |
| `mem_export` | Export full Markdown memory report |

And slash commands:

| Command | Description |
|---------|-------------|
| `/mem-status` | Extension health check |
| `/mem-daily` | View today's daily log |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_MEM_AMBIENT` | `0` | Enable ambient context injection (set to `1`) |
| `PI_MEM_DIR` | `~/.pi/agent/memory` | Database directory |
| `PI_MEM_AMBIENT_MAX_CHARS` | `5000` | Max chars for injected context |
| `PI_MEM_AMBIENT_MAX_FACTS` | `5` | Max high-importance facts to inject |

## Architecture

```
All data in a single SQLite file (~/.pi/agent/memory/hindsight.db):

┌─────────────┐  ┌────────────┐  ┌──────────────┐  ┌────────┐
│  memories   │  │ scratchpad │  │  daily_logs  │  │ config │
│  FTS5+vec0  │  │ todo list  │  │  append-only │  │  KV    │
└─────────────┘  └────────────┘  └──────────────┘  └────────┘
```

**Events:**
- `message_end` → tier-1 capture (heuristic pattern matching)
- `session_shutdown` → decay + daily log auto-append
- `session_before_compact` → handoff summary to daily logs
- `before_agent_start` → ambient injection (if `PI_MEM_AMBIENT=1`)

## License

MIT