# pi-hindsight 🧠

> A pi extension for cross-session memory: FTS5 + vector search, scratchpad, daily logs, and ambient context injection.

## Features

| Feature | Description |
|---------|-------------|
| **Memory Recall** | Hybrid FTS5 keyword + sqlite-vec vector ANN search with RRF fusion (v0.3: real kNN — local hash embedder by default, optional HTTP neural embedder) |
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
| `memory_write` | Explicitly write a memory (summary, category, detail, importance, tags) |
| `memory_forget` | Archive (soft-delete) a memory by ID or keyword query |
| `memory_restore` | Restore archived (soft-deleted) memories by ID or keyword query |
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
| `PI_MEM_EMBED` | `local` | Embedder mode: `local` (zero-dep hash) or `http` (OpenAI-compatible) |
| `PI_MEM_EMBED_BASE_URL` | — | HTTP embedder endpoint, e.g. `http://127.0.0.1:4000/v1` (new-api gateway) |
| `PI_MEM_EMBED_API_KEY` | — | Optional bearer token for the embed endpoint |
| `PI_MEM_EMBED_MODEL` | `text-embedding-3-small` | Embedding model name |

### Vector Embeddings (v0.3.0)

- **Default `local` embedder**: deterministic char n-gram (3-4) feature hashing → 1536-dim, L2-normalized. Zero dependencies, offline, instant (~2k vec/s). Quality is lexical-overlap similarity, not neural — fine for short memory summaries.
- **Optional `http` embedder**: any OpenAI-compatible `/v1/embeddings` endpoint (set `PI_MEM_EMBED_BASE_URL`, optionally `_API_KEY`/`_MODEL`). Dimension must be 1536; on any failure it falls back to the local embedder so vector recall never breaks.
- **Write path**: every new memory gets a vector on first insert (upserts skip — content hash keeps ids stable); capture batches embed in one call; on load, missing vectors are backfilled automatically (idempotent).
- **`recall_memory` modes**: `fts` (keyword), `vector` (kNN on the query embedding), `hybrid` (RRF fusion, 0.6 FTS + 0.4 vector). Archived memories are excluded from all modes.

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