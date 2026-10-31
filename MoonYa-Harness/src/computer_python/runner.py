import io
import json
import sys
import os
import traceback
import ast
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
import seed_computer_use as cu

class Output(io.StringIO):
    def write(self, text):
        remaining = max(0, 64000 - self.tell())
        super().write(text[:remaining])
        return len(text)

request = json.loads(sys.stdin.readline())
output = Output()
sys.stdout = output
try:
    tree = ast.parse(request["code"], "<desktop-cell>")
    aliases = {node.asname or node.name for node in ast.walk(tree) if isinstance(node, ast.alias) and node.name == "seed_computer_use"}
    direct = {alias.asname or alias.name for node in ast.walk(tree) if isinstance(node, ast.ImportFrom) and node.module == "seed_computer_use" for alias in node.names}
    calls = [node.func for node in ast.walk(tree) if isinstance(node, ast.Call)]
    if not any((isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name) and func.value.id in aliases) or (isinstance(func, ast.Name) and func.id in direct) for func in calls):
        raise RuntimeError("Use file/shell tools for cells that do not call seed_computer_use.")
    exec(compile(request["code"], "<desktop-cell>", "exec"), {"__name__": "__main__"})
    if cu._calls == 0:
        raise RuntimeError("A desktop cell must call seed_computer_use; use file or shell tools for non-desktop work.")
    result = {"success": True, "output": output.getvalue()}
except BaseException:
    result = {"success": False, "error_code": "desktop_cell_failed", "error": traceback.format_exc(limit=8), "output": output.getvalue()}
cu._channel.write(json.dumps({"kind": "result", "result": result}, ensure_ascii=True) + "\n")
cu._channel.flush()
