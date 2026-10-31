#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把 MySQL 8.0 的 mysqldump 输出降级为 MySQL 5.7 可直接导入的 SQL。

处理项：
1. utf8mb4_0900_ai_ci / utf8mb4_0900_as_ci / utf8mb4_0900_bin 等 8.0 专有排序规则
   -> utf8mb4_unicode_ci（5.7 存在且语义最接近）
2. 表选项补 ROW_FORMAT=DYNAMIC，规避 5.7 上 utf8mb4 前缀索引 767 字节上限
3. 顶部补一组“无条件”SET 语句（部分 GUI 导入器会剥掉 /*! */ 注释）
4. 去掉 8.0 专有的 /*!80016 ... */ 之类版本注释（保留 5.x 可执行的）

用法：
    python tools/sql_to_mysql57.py <输入.sql> [-o 输出.sql]
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

# MySQL 8.0 引入的排序规则 -> 5.7 等价（可用的）排序规则
COLLATION_MAP = {
    "utf8mb4_0900_ai_ci": "utf8mb4_unicode_ci",
    "utf8mb4_0900_as_ci": "utf8mb4_unicode_ci",
    "utf8mb4_0900_as_cs": "utf8mb4_bin",
    "utf8mb4_0900_bin": "utf8mb4_bin",
    "utf8mb4_ja_0900_as_cs": "utf8mb4_unicode_ci",
    "utf8mb4_zh_0900_as_cs": "utf8mb4_unicode_ci",
}

# 8.0 新增的版本注释：>= 80000 的整段去掉（5.7 本来也不会执行，去掉更干净）
RE_800_COMMENT = re.compile(r"/\*!8\d{4}[^*]*\*/;?\s*")

RE_TABLE_TAIL = re.compile(
    r"^\)\s*ENGINE=(?P<engine>[A-Za-z]+)(?P<rest>.*?);\s*$", re.IGNORECASE | re.MULTILINE
)

HEADER_PREFIX = """-- =====================================================================
-- MySQL 5.7 兼容版本 -- 由 tools/sql_to_mysql57.py 自动转换
-- 原始文件：{src}
-- 转换时间：{ts}
-- 主要改动：8.0 专有排序规则(0900 系列) -> utf8mb4_unicode_ci；
--           表选项补 ROW_FORMAT=DYNAMIC（规避 767 字节索引前缀上限）
-- =====================================================================
SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;
SET UNIQUE_CHECKS = 0;
SET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';

"""


def convert(sql: str, src_name: str, ts: str) -> tuple[str, dict]:
    stats = {k: 0 for k in COLLATION_MAP}
    stats["row_format"] = 0
    stats["comment800"] = 0

    for bad, good in COLLATION_MAP.items():
        pattern = r"((?:COLLATE\s*=?\s*|collation_connection\s*=\s*)[\'\"]?)" + re.escape(bad) + r"\b"
        n = len(re.findall(pattern, sql, flags=re.IGNORECASE))
        if n:
            stats[bad] = n
            sql = re.sub(pattern, lambda match: match.group(1) + good, sql, flags=re.IGNORECASE)

    # 去掉 >= 8.0 的版本注释块
    sql, n = RE_800_COMMENT.subn("", sql)
    stats["comment800"] = n

    # 表选项补 ROW_FORMAT=DYNAMIC（仅 InnoDB，且尚未显式指定时不加）
    def _tail(m: re.Match) -> str:
        engine = m.group("engine")
        rest = m.group("rest")
        if engine.upper() != "INNODB" or re.search(r"ROW_FORMAT", rest, re.IGNORECASE):
            return m.group(0)
        stats["row_format"] += 1
        return ") ENGINE=%s ROW_FORMAT=DYNAMIC%s;" % (engine, rest)

    sql = RE_TABLE_TAIL.sub(_tail, sql)

    # 顶部替换 mysqldump 头
    sql = re.sub(
        r"^-- MySQL dump .*?\n", "-- MySQL dump (converted for MySQL 5.7)\n", sql, count=1
    )
    sql = HEADER_PREFIX.format(src=src_name, ts=ts) + sql
    return sql, stats


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("input", help="待转换的 .sql 文件")
    ap.add_argument("-o", "--output", help="输出路径（默认 <输入>_mysql57.sql）")
    args = ap.parse_args()

    src = Path(args.input)
    if not src.is_file():
        print("找不到文件: %s" % src, file=sys.stderr)
        return 2

    raw = src.read_bytes().decode("utf-8", errors="surrogateescape")

    # 统一成 LF 处理，最后按源文件风格还原换行符
    crlf = raw.count("\r\n") > 0
    raw = raw.replace("\r\n", "\n").replace("\r", "\n")

    from datetime import datetime

    out_sql, stats = convert(raw, src.name, datetime.now().strftime("%Y-%m-%d %H:%M:%S"))

    if crlf:
        out_sql = out_sql.replace("\n", "\r\n")

    dst = Path(args.output) if args.output else src.with_name(src.stem + "_mysql57.sql")
    dst.write_bytes(out_sql.encode("utf-8", errors="surrogateescape"))

    print("输入: %s (%d 字节)" % (src, src.stat().st_size))
    print("输出: %s (%d 字节)" % (dst, dst.stat().st_size))
    for k, v in stats.items():
        if v:
            print("  %-24s %d" % (k, v))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
