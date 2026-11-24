#!/usr/bin/env python3
"""管理 chat-soul-bridge 的本地 SQLite + FTS5 记忆库（state/memory.db）。

与 scripts/recall.py 完全同构：
  - msg / msg_fts（聊天记录 + 中文单字/二元组 + 英文数字 FTS5 全文索引）
  - diary_chunk / diary_fts（日记记录 + FTS5 全文索引）

用法：
  python scripts/memory-db.py init
  echo '{...}' | python scripts/memory-db.py ingest-msg
  echo '{...}' | python scripts/memory-db.py ingest-diary
  python scripts/memory-db.py --stdio    # 常驻行协议写入服务（省去进程冷启动开销）
"""
import json
import os
import sqlite3
import sys
import time
from datetime import datetime

# 复用 recall.py 里完全一致的 tokenize 与 DB 路径，保证索引和查询 100% 对齐
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from recall import DB, tokenize  # noqa: E402


SCHEMA_SQL = """
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS msg (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    day         TEXT NOT NULL,
    scope       TEXT NOT NULL,          -- 'private' | 'group'
    who         INTEGER NOT NULL,       -- 发送者 QQ 号
    who_name    TEXT NOT NULL DEFAULT '',
    is_self     INTEGER NOT NULL DEFAULT 0,
    text        TEXT NOT NULL,
    weight      REAL NOT NULL DEFAULT 0.5,
    ts          REAL NOT NULL,          -- Unix 时间戳（秒）
    kind        TEXT NOT NULL DEFAULT 'message', -- 'message' | 'thought'
    tags        TEXT NOT NULL DEFAULT '',
    tier        TEXT NOT NULL DEFAULT 'normal',  -- 'core' | 'normal' | 'archive'
    group_id    INTEGER,                -- 群号（私聊为 NULL）
    message_id  TEXT DEFAULT ''         -- OneBot message_id
);

CREATE INDEX IF NOT EXISTS idx_msg_day    ON msg(day);
CREATE INDEX IF NOT EXISTS idx_msg_who    ON msg(who);
CREATE INDEX IF NOT EXISTS idx_msg_scope  ON msg(scope);
CREATE INDEX IF NOT EXISTS idx_msg_tier   ON msg(tier);
CREATE INDEX IF NOT EXISTS idx_msg_ts     ON msg(ts DESC);
CREATE INDEX IF NOT EXISTS idx_msg_group  ON msg(group_id);

CREATE VIRTUAL TABLE IF NOT EXISTS msg_fts USING fts5(tokens);

CREATE TABLE IF NOT EXISTS diary_chunk (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    day         TEXT NOT NULL,
    path        TEXT NOT NULL DEFAULT 'state/diary.json',
    chunk_no    INTEGER NOT NULL DEFAULT 1,
    text        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_diary_day ON diary_chunk(day);

CREATE VIRTUAL TABLE IF NOT EXISTS diary_fts USING fts5(tokens);
"""


def open_db(db_path=DB):
    os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
    con = sqlite3.connect(db_path, timeout=5.0)
    con.executescript(SCHEMA_SQL)
    return con


def ingest_msg(con, item):
    text = str(item.get('text') or '').strip()
    if not text:
        return {'ok': False, 'error': 'empty text'}

    ts = float(item.get('ts') or time.time())
    day = str(item.get('day') or datetime.fromtimestamp(ts).strftime('%Y-%m-%d'))
    scope = 'group' if item.get('scope') == 'group' else 'private'
    who = int(item.get('who') or 0)
    who_name = str(item.get('who_name') or '')
    is_self = 1 if item.get('is_self') else 0
    weight = float(item.get('weight') if item.get('weight') is not None else 0.5)
    kind = 'thought' if item.get('kind') == 'thought' else 'message'
    tags = str(item.get('tags') or '')
    tier = str(item.get('tier') or ('core' if weight >= 0.7 else 'normal'))
    group_id = int(item['group_id']) if item.get('group_id') not in (None, '') else None
    message_id = str(item.get('message_id') or '')

    # 按 (scope, message_id) 自动去重，支持重复运行历史导入脚本而不产生重复记录
    if message_id:
        dup = con.execute(
            'SELECT id FROM msg WHERE scope = ? AND message_id = ? LIMIT 1',
            (scope, message_id),
        ).fetchone()
        if dup:
            return {'ok': True, 'rowid': dup[0], 'duplicate': True}

    cur = con.execute(
        """
        INSERT INTO msg (day, scope, who, who_name, is_self, text, weight, ts, kind, tags, tier, group_id, message_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (day, scope, who, who_name, is_self, text, weight, ts, kind, tags, tier, group_id, message_id),
    )
    rowid = cur.lastrowid
    tokens = ' '.join(tokenize(text))
    if tokens:
        con.execute('INSERT INTO msg_fts(rowid, tokens) VALUES (?, ?)', (rowid, tokens))
    con.commit()
    return {'ok': True, 'rowid': rowid}


def update_msg_text(con, item):
    """按 (scope, message_id) 回填更新消息正文（如为图片补充文字图注），并同步重建该条 FTS5 索引。"""
    scope = 'group' if item.get('scope') == 'group' else 'private'
    message_id = str(item.get('message_id') or '').strip()
    new_text = str(item.get('text') or '').strip()
    if not message_id or not new_text:
        return {'ok': False, 'error': 'message_id and text required'}

    row = con.execute(
        'SELECT id FROM msg WHERE scope = ? AND message_id = ? LIMIT 1',
        (scope, message_id),
    ).fetchone()
    if not row:
        return {'ok': False, 'error': 'message not found'}

    rowid = row[0]
    con.execute('UPDATE msg SET text = ? WHERE id = ?', (new_text, rowid))
    con.execute('DELETE FROM msg_fts WHERE rowid = ?', (rowid,))
    tokens = ' '.join(tokenize(new_text))
    if tokens:
        con.execute('INSERT INTO msg_fts(rowid, tokens) VALUES (?, ?)', (rowid, tokens))
    con.commit()
    return {'ok': True, 'rowid': rowid}


def ingest_diary(con, item):
    text = str(item.get('text') or item.get('content') or '').strip()
    if not text:
        return {'ok': False, 'error': 'empty diary text'}

    day = str(item.get('day') or datetime.now().strftime('%Y-%m-%d'))
    path = str(item.get('path') or f'state/diary/{day}.md')
    row = con.execute('SELECT COALESCE(MAX(chunk_no), 0) FROM diary_chunk WHERE day = ?', (day,)).fetchone()
    chunk_no = int(item.get('chunk_no') or ((row[0] if row else 0) + 1))

    cur = con.execute(
        'INSERT INTO diary_chunk (day, path, chunk_no, text) VALUES (?, ?, ?, ?)',
        (day, path, chunk_no, text),
    )
    rowid = cur.lastrowid
    tokens = ' '.join(tokenize(text))
    if tokens:
        con.execute('INSERT INTO diary_fts(rowid, tokens) VALUES (?, ?)', (rowid, tokens))
    con.commit()
    return {'ok': True, 'id': rowid, 'chunk_no': chunk_no}


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'init'
    con = open_db(DB)
    try:
        if cmd == 'init':
            print(json.dumps({'ok': True, 'db': DB}, ensure_ascii=False))
            return 0
        if cmd == 'ingest-msg':
            data = json.loads(sys.stdin.read() or '{}')
            print(json.dumps(ingest_msg(con, data), ensure_ascii=False))
            return 0
        if cmd == 'ingest-diary':
            data = json.loads(sys.stdin.read() or '{}')
            print(json.dumps(ingest_diary(con, data), ensure_ascii=False))
            return 0
        if cmd == '--stdio':
            for line in sys.stdin:
                line = line.strip()
                if not line:
                    continue
                try:
                    req = json.loads(line)
                    op = req.get('op')
                    if op == 'ingest-msg':
                        res = ingest_msg(con, req.get('data') or {})
                    elif op == 'update-msg-text':
                        res = update_msg_text(con, req.get('data') or {})
                    elif op == 'ingest-diary':
                        res = ingest_diary(con, req.get('data') or {})
                    else:
                        res = {'ok': False, 'error': f'unknown op: {op}'}
                except Exception as exc:
                    res = {'ok': False, 'error': str(exc)}
                sys.stdout.write(json.dumps(res, ensure_ascii=False) + '\n')
                sys.stdout.flush()
            return 0
        print(json.dumps({'ok': False, 'error': f'unknown command: {cmd}'}, ensure_ascii=False))
        return 1
    finally:
        con.close()


if __name__ == '__main__':
    sys.exit(main())
