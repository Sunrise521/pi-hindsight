# pi-hindsight 实现规格书

> 混合方案：better-sqlite3 + FTS5 + sqlite-vec 存储层 + pi-memory 风格的注入/scratchpad/daily_log/handoff 功能层。
>
> 设计文档：`pi-config-overview.md §12`

---

## 1. 架构总览

```
┌──────────────────────────────────────────────────────────────────┐
│                    pi-hindsight（一个 pi 扩展）                    │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │  Long-term   │  │  Scratchpad  │  │  Daily Log           │   │
│  │  Memory      │  │  (待办清单)    │  │  (每日日志)           │   │
│  ├──────────────┤  ├──────────────┤  ├──────────────────────┤   │
│  │ FTS5 + vec0  │  │ open/done    │  │ append-only, 按天     │   │
│  │ tier-1 auto  │  │ checkpointed │  │ session_shutdown     │   │
│  │ dedup/decay  │  │ per-session  │  │ 自动追加              │   │
│  └──────────────┘  └──────────────┘  └──────────────────────┘   │
│                                                                  │
│  ┌──────────────────────┐  ┌────────────────────────────────┐   │
│  │ Session Handoff      │  │  Context Injection（可选）      │   │
│  │ session_before_      │  │  PI_MEM_AMBIENT=1 →            │   │
│  │ compact → 写接力摘要  │  │  before_agent_start 注入      │   │
│  └──────────────────────┘  │   high-signal facts + daily    │   │
│                            │   ≤ 4K char, KV snapshot       │   │
│                            └────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

### 存储层（单一 SQLite 文件）

```
~/.pi/agent/memory/hindsight.db
```

所有数据在一个文件里，无需外部进程、无需额外配置。

---

## 2. Schema

```sql
-- ——————————————————————————————————————
-- 2.1 长时记忆（核心）
-- ——————————————————————————————————————

CREATE TABLE memories (
  id           INTEGER PRIMARY KEY,
  project_key  TEXT NOT NULL,
  session_id   TEXT,
  turn_index   INTEGER,
  category     TEXT NOT NULL CHECK (category IN (
    'decision','fact','preference','change','error','task','constraint'
  )),
  summary      TEXT NOT NULL,                  -- 紧凑记忆（≈ 1 句）
  detail       TEXT,                           -- 完整上下文（tier-2 可选）
  content_hash TEXT NOT NULL UNIQUE,           -- 去重键（SHA256）
  tags         TEXT,                           -- 逗号分隔的 #tags（FTS5 友好）
  importance   REAL NOT NULL DEFAULT 0.5 CHECK (importance BETWEEN 0 AND 1),
  confidence   REAL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  access_cnt   INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','curated','archived','conflict')),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  accessed_at  INTEGER
);

CREATE INDEX idx_mem_proj_cat   ON memories(project_key, category, importance DESC);
CREATE INDEX idx_mem_created    ON memories(project_key, created_at DESC);

-- FTS5（独立表 + 触发器，避免内容表同步坑）
CREATE VIRTUAL TABLE memories_fts USING fts5(summary, detail, tags, tokenize='unicode61');

CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, summary, detail, tags)
  VALUES (new.id, new.summary, new.detail, new.tags);
END;

CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid) VALUES('delete', old.id);
END;

CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid) VALUES('delete', old.id);
  INSERT INTO memories_fts(rowid, summary, detail, tags)
  VALUES (new.id, new.summary, new.detail, new.tags);
END;

-- vec0（向量 ANN，sqlite-vec）
CREATE VIRTUAL TABLE memories_vec USING vec0(embedding float[1536]);

-- ——————————————————————————————————————
-- 2.2 Scratchpad（待办清单）
-- ——————————————————————————————————————

CREATE TABLE scratchpad (
  id          INTEGER PRIMARY KEY,
  project_key TEXT NOT NULL,
  session_id  TEXT,
  label       TEXT NOT NULL,        -- 待办描述
  priority    INTEGER DEFAULT 1,    -- 0=low, 1=normal, 2=high
  status      TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','done','cancelled')),
  created_at  INTEGER NOT NULL,
  done_at     INTEGER,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX idx_sp_proj_status ON scratchpad(project_key, status, priority DESC);

-- ——————————————————————————————————————
-- 2.3 Daily Log（每日日志）
-- ——————————————————————————————————————

CREATE TABLE daily_logs (
  id          INTEGER PRIMARY KEY,
  project_key TEXT NOT NULL,
  date        TEXT NOT NULL,         -- YYYY-MM-DD
  content     TEXT NOT NULL,
  entry_type  TEXT DEFAULT 'auto',   -- 'auto' | 'manual'
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_dl_date ON daily_logs(project_key, date, created_at);

-- ——————————————————————————————————————
-- 2.4 可选：项目配置
-- ——————————————————————————————————————

CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

---

## 3. 工具清单

| 工具名 | 功能 | 调用者 | 频次 |
|--------|------|--------|------|
| `recall_memory` | FTS5 + vec0 双路召回，RRF 融合 | 模型按需 | 低 |
| `mem_count` | 按类别统计记忆数 | 模型/用户 | 低 |
| `scratch` | scratchpad add/list/done/clear | 模型按需 | 中 |
| `mem_daily` | 手动追加 daily_log | 模型/用户 | 低 |
| `mem_export` | 导出可读 Markdown 视图（MEMORY.md） | 用户 | 低 |
| `/mem-status` | 扩展健康检查命令 | 用户 | 低 |
| `/mem-daily` | 查看今日日志命令 | 用户 | 低 |

---

## 4. 事件处理

| 事件 | 用途 | 场景 |
|------|------|------|
| `message_end` | tier-1 capture：启发式提取 assistant 回复中的决策/事实/变更 | 每回合 |
| `session_shutdown` | 跑 decay 归档；自动追加 daily_log 摘要 | 会话结束 |
| `session_before_compact` | 写接力摘要到 daily_logs（pi-memory 的 handoff） | 压缩前 |
| `before_agent_start` | **仅 PI_MEM_AMBIENT=1 时**：注入 daily + TOP facts | 回合前 |

### tier-1 启发式捕获策略

在 `message_end` 中拦截 assistant 消息，按下面的策略识别关键信息：

1. **文本提取**：取所有 `type: "text"` 的 content block，拼成完整句子
2. **分类匹配**（按优先级）：
   - `decision` → 匹配 "decided/chose/will use/going with/approach is"
   - `change` → 匹配 "added/removed/changed/refactored/migrated"
   - `preference` → 匹配 "prefer/like/want/don't want/avoid"
   - `fact` → 匹配 "is a/runs on/uses/depends on/architecture"
   - `task` → 匹配 "need to/have to/todo/fix/implement"
   - `constraint` → 匹配 "must/can't/required/mandatory/locked"
   - `error` → 匹配 "error/failed/broken/crash"
3. **重要性赋值**：匹配度 0.2-0.5（tier-1 置信度低，由 tier-2 提升）
4. **去重**：`content_hash = SHA256(summary + detail)` 防止同回合重复
5. **跳过**：短文本（< 20 char）、代码块、纯标点

写入通过 `ON CONFLICT DO UPDATE`（upsert），避免重复插入。

---

## 5. 召回策略

### 5.1 召回流程

```
recall_memory(query, { category?, limit?, mode? })
                           │
               ┌───────────┴───────────┐
               ▼                       ▼
          FTS5 关键词             vec0 向量 ANN
          BM25 排序              余弦距离排序
               │                       │
               └───────────┬───────────┘
                           ▼
                      RRF 融合
                  score = 0.6×fts + 0.4×vec
                           │
                           ▼
                   取 top-K（≤ limit）
                category 过滤 → 返回
```

### 5.2 融合评分

```
recall_score = w_fts * bm25_norm
             + w_vec * vec_norm

bm25_norm = 1 / (1 + bm25_raw)      -- 0~1
vec_norm  = 1 / (1 + distance)       -- 0~1

w_fts = 0.6, w_vec = 0.4（默认）
```

### 5.3 排序后因素

返回前按此公式调整最终排序（参与 `ORDER BY`）：

```
final_rank = recall_score * 0.7
           + importance  * 0.2
           + recency_norm * 0.1

recency_norm = exp(-0.01 * days_since_created)
```

---

## 6. 可选注入模式（PI_MEM_AMBIENT）

### 6.1 默认行为（AA = ambient off）

- `recall_memory` 工具按需调用
- 零额外 token 消耗
- 适合：API 用户（按 token 计费）、注重上下文纯净度的用户

### 6.2 注入模式（ambient on，PI_MEM_AMBIENT=1）

在 `before_agent_start` 事件中注入到 system prompt：

```
注入内容（按优先级）：
1. 今日 daily_log 尾部（≤ 2K char）—— 上下文连续性
2. 高重要性记忆 TOP-5（importance ≥ 0.7，≤ 2K char）—— 关键决策不遗忘
3. 当前 open scratchpad items（≤ 1K char）—— 待办提醒

总上限：5K char
```

### 6.3 KV-cache stable snapshot（参考 pi-memory）

注入内容只在以下时机刷新，其余回合**字节级稳定**：

- `session_start`（首次）
- `session_before_compact`（压缩后）
- 新 `memory_write` 写入 high-importance 记忆后（标记 dirty）
- 日切换（UTC 日期变化）

此机制对 prefix-caching runtime（llama.cpp/vLLM/MLX）性价比极高——每一轮省去 5K token 的前缀重计算。

---

## 7. scratchpad 规格

### 7.1 工具接口

```json
// scratch({ action: "add", label: "...", priority?: 0|1|2 })
// scratch({ action: "done", id: 123 })
// scratch({ action: "list", status?: "open"|"done" })
// scratch({ action: "clear", status: "done" })
// scratch({ action: "undo", id: 123 })
```

### 7.2 生命周期

- `open` → 用户 `scratch done` → `done`（记录 done_at）
- `open` → 用户 `scratch undo` → `cancelled`
- `done` 项在 session_shutdown 时自动清理（> 7 天）
- 注入模式开启时，open 项自动进入 system prompt

---

## 8. daily_log 规格

### 8.1 自动追加

在 `session_shutdown` 时自动追加一行：

```
{project_key, date: today, content: "Session handoff: [n] turns, [m] memories captured"}
```

### 8.2 手动追加

通过 `mem_daily` 工具追加用户/模型产出的日志内容。

### 8.3 session handoff

在 `session_before_compact` 时写接力摘要：

```
## Session Handoff 2026-07-17 14:30
- Open scratchpad: [3 items]
- 新增记忆: 5 (2 decisions, 2 facts, 1 change)
- 重要决策: "..."
```

---

## 9. 配置项

| 环境变量 | 类型 | 默认值 | 说明 |
|---------|------|--------|------|
| `PI_MEM_AMBIENT` | `0`/`1` | `0` | 启用 context injection 模式 |
| `PI_MEM_DIR` | path | `~/.pi/agent/memory` | DB 文件目录 |
| `PI_MEM_VEC_DIM` | int | `1536` | 向量维度（需与 embedding 模型匹配） |
| `PI_MEM_AMBIENT_MAX_CHARS` | int | `5000` | 注入最大字符数 |
| `PI_MEM_AMBIENT_MAX_FACTS` | int | `5` | 注入高重要性记忆条数 |

---

## 10. 实现状态

| # | 模块 | 状态 | 优先级 |
|:-:|------|:----:|:------:|
| 1 | `memory-store.ts` — schema + FTS5 + vec0 + CRUD + RRF | ✅ 完成 | P0 |
| 2 | `capture.ts` — tier-1 启发式捕获 | ✅ 完成 | P0 |
| 3 | `recall-tool.ts` — recall_memory + mem_count + /mem-status | ✅ 完成 | P0 |
| 4 | scratchpad 表 + `scratch` 工具 | ✅ 完成 | P1 |
| 5 | daily_logs 表 + `mem_daily` 工具 + 自动追加 | ✅ 完成 | P1 |
| 6 | `session_before_compact` handoff | ✅ 完成 | P1 |
| 7 | 注入模式 `PI_MEM_AMBIENT` + `before_agent_start` | ✅ 完成 | P2 |
| 8 | `mem_export` 工具（Markdown 视图） | ✅ 完成 | P2 |
| 9 | tier-2 蒸馏（pi-exec headless） | ⬜ 待实现 | P2 |
| — | `tags` 列加入 memories 表 + FTS5 索引 | ✅ 补充 | P0 |
| — | `config` 表 + configGet/configSet | ✅ 补充 | P1 |

---

## 11. 参考

- pi-memory: https://pi.dev/packages/pi-memory
- sqlite-vec: https://github.com/asg017/sqlite-vec
- better-sqlite3: https://github.com/WiseLibs/better-sqlite3
- pi-config-overview.md §12: 设计文档
