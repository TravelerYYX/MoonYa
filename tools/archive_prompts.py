# -*- coding: utf-8 -*-
"""MoonYa Harness 化重构 - 阶段1: 提示词归档
从 ai_system_old (MySQL 8 暂存库, 源 MariaDB dump) 导出提示词为 JSON。
输出: MoonYa-Harness/docs/prompts-archive/{agents,personality,tool_settings,system_prompts}.json + index.json
"""
import json
import subprocess
import sys
from datetime import datetime, timezone, timedelta

MYSQL = "mysql"
DB = "ai_system_old"
OUT_DIR = r"D:\Project\Project\MoonYa\MoonYa-Harness\docs\prompts-archive"
ARCHIVED_AT = datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds")

# system_prompts 分类: 旧 agent 体系(归档后可考虑从库中清理) vs 通用保留
LEGACY_AGENT_NAMES = {
    "agent", "agent_planning", "agent_error_recovery", "agent_planning_instruction",
    "agent_moonya", "agent_app", "agent_computer", "agent_browser",
    "agent_file", "agent_search", "agent_code",
}

TABLES = [
    ("agents", "各专业 Agent 定义与提示词（旧 agent 团队体系，留待封装插件）"),
    ("personality", "AI 人格定义（name/description/use_custom，留待封装插件）"),
    ("tool_settings", "写作助手、翻译助手等工具提示词（功能已删除，留待参考）"),
    ("system_prompts", "系统提示词快照：legacy_agent_system=旧 agent 体系条目；retained_general=通用条目（保留在库）"),
]


def run_sql(sql):
    r = subprocess.run(
        [MYSQL, "-P3306", "-uroot", "-pyueyaxuan", "--default-character-set=utf8mb4",
         "--batch", "--raw", "-N", DB, "-e", sql],
        capture_output=True,
    )
    if r.returncode != 0:
        raise RuntimeError(f"mysql error: {r.stderr.decode('utf-8', 'replace')}")
    return r.stdout.decode("utf-8", "replace").strip()


def get_columns(table):
    out = run_sql(
        "SELECT COLUMN_NAME FROM information_schema.COLUMNS "
        f"WHERE TABLE_SCHEMA='{DB}' AND TABLE_NAME='{table}' ORDER BY ORDINAL_POSITION"
    )
    return [c for c in out.splitlines() if c]


def get_rows_json(table, columns):
    obj = ", ".join(f"'{c}', `{c}`" for c in columns)
    out = run_sql(f"SELECT JSON_ARRAYAGG(JSON_OBJECT({obj})) FROM `{table}`")
    if not out or out == "NULL":
        return []
    return json.loads(out)


def main():
    index = {"archived_at": ARCHIVED_AT,
             "source_database": "ai_system (MariaDB 10.4.32, dump 2026-08-09)",
             "staging_database": f"{DB} (MySQL 8.0.46 暂存)",
             "note": "提示词归档，留待封装插件时程序化读取",
             "files": []}
    for table, purpose in TABLES:
        cols = get_columns(table)
        rows = get_rows_json(table, cols)
        if table == "system_prompts":
            for r in rows:
                r["archive_class"] = ("legacy_agent_system"
                                      if r.get("name") in LEGACY_AGENT_NAMES
                                      else "retained_general")
        schema = run_sql(f"SHOW CREATE TABLE `{table}`")
        payload = {
            "archived_at": ARCHIVED_AT,
            "source_table": table,
            "source_database": "ai_system (MariaDB 10.4.32)",
            "row_count": len(rows),
            "schema_notes": schema,
            "records": rows,
        }
        path = rf"{OUT_DIR}\{table}.json"
        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        legacy = sum(1 for r in rows if r.get("archive_class") == "legacy_agent_system")
        index["files"].append({
            "file": f"{table}.json", "source_table": table,
            "row_count": len(rows),
            "legacy_agent_system_rows": legacy if table == "system_prompts" else None,
            "purpose": purpose,
        })
        print(f"[OK] {table}: {len(rows)} rows -> {path}")
    with open(rf"{OUT_DIR}\index.json", "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)
    print("[OK] index.json written")


if __name__ == "__main__":
    sys.exit(main())
