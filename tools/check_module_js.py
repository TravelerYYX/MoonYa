#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
校验 MoonYa-Backend/script/MoonYa-index/modules/*.php 里内嵌的 JS 语法。

这些模块有的自带 <script> 包裹、有的没有（由 index.php 统一包裹），
因此策略是：剥离 <?php ... ?> 片段与 <script> 标签后按整文件写 .js，
再交给 node --check 做语法校验。

剥离 PHP 块的两个坑：
  1. 不能替换成空串 —— `const X = <?php echo ... ?>;` 会残留孤立 `;`；
  2. 不能保留块内换行 —— `const S = '<?php ... ?>';` 会变成跨行字符串字面量。
因此把整个 PHP 块折叠成单行占位符 `"0"`，再补 (行数-1) 个空行保持行号稳定。
占位符用双引号，可同时适配表达式上下文与单引号字符串上下文。

用法:
    python tools/check_module_js.py [模块文件名...]
不带参数则校验 modules/ 下所有 script-*.php。
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODULES = os.path.join(ROOT, 'MoonYa-Backend', 'script', 'MoonYa-index', 'modules')
# 中间产物默认写入系统临时目录并在结束后清理；加 --keep 才留在模块目录便于排查。
KEEP_OUT = os.path.join(ROOT, 'MoonYa-Backend', 'script', 'MoonYa-index', '_jscheck')
NODE = r'C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-3\node.exe'

PHP_BLOCK = re.compile(r'<\?php.*?\?>', re.S)
SCRIPT_TAG = re.compile(r'^[ \t]*</?script[^>]*>[ \t]*$', re.M)


def _collapse_php(text: str) -> str:
    """折叠 PHP 块为 `"0"`，并把块内换行补到块之后，保证总行数不变。"""
    out = []
    last = 0
    for m in PHP_BLOCK.finditer(text):
        out.append(text[last:m.start()])
        out.append('"0"')
        n = m.group(0).count('\n')
        eol = text.find('\n', m.end())
        if eol == -1:
            eol = len(text)
        # 同一行 `?>` 之后的内容必须提到替换位置，否则字符串会被拆行
        out.append(text[m.end():eol])
        out.append('\n' * n)
        last = eol
    out.append(text[last:])
    return ''.join(out)


def strip_php(text: str) -> str:
    return SCRIPT_TAG.sub('', _collapse_php(text))


def main() -> int:
    args = sys.argv[1:]
    keep = '--keep' in args
    targets = [a for a in args if a != '--keep']
    if targets:
        files = [os.path.join(MODULES, t if t.endswith('.php') else t + '.php') for t in targets]
    else:
        files = sorted(
            os.path.join(MODULES, f)
            for f in os.listdir(MODULES)
            if f.startswith('script-') and f.endswith('.php')
        )

    out_dir = KEEP_OUT if keep else tempfile.mkdtemp(prefix='moonya-jscheck-')
    os.makedirs(out_dir, exist_ok=True)
    failed = []
    try:
        for path in files:
            name = os.path.basename(path)
            with open(path, encoding='utf-8') as fh:
                js = strip_php(fh.read())
            js_path = os.path.join(out_dir, name[:-4] + '.js')
            with open(js_path, 'w', encoding='utf-8') as fh:
                fh.write(js)
            r = subprocess.run([NODE, '--check', js_path], capture_output=True, text=True)
            if r.returncode == 0:
                print(f'{name:40s} OK')
            else:
                print(f'{name:40s} FAIL')
                for ln in (r.stderr or r.stdout).strip().split('\n')[:8]:
                    print('    ' + ln)
                failed.append(name)
    finally:
        if not keep:
            shutil.rmtree(out_dir, ignore_errors=True)

    print()
    if failed:
        print(f'{len(failed)} 个文件语法失败: {", ".join(failed)}')
        return 1
    print(f'全部 {len(files)} 个模块语法通过')
    return 0


if __name__ == '__main__':
    sys.exit(main())
