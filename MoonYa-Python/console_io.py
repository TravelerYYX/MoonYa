"""控制台/管道输出编码统一工具。

MoonYa 的 Python 后端由 C#（WebCrawlerService）以重定向管道方式启动。
Windows 下 Python 在管道中不会使用交互式控制台的 UTF-8 代码页，而是回退到
系统区域编码（中文 Windows 为 GBK/cp936）。此时任何非 GBK 字符（表情符号、
部分箭头等）都会让 print 抛出 UnicodeEncodeError → 进程崩溃退出。

典型事故：main.py 在端口绑定成功后打印启动横幅，其中的 "✅" 触发
    UnicodeEncodeError: 'gbk' codec can't encode character '\u2705'
导致服务实际已监听端口却立即退出。

父进程按 UTF-8 解码管道内容，因此这里把所有标准流固定为 UTF-8，
并对无法编码的字符做 replace 兜底，保证任何日志都不会杀死服务进程。
"""

from __future__ import annotations

import sys

_configured = False


def configure_stdio() -> None:
    """把 stdout/stderr 固定为 UTF-8（errors=replace），可重复调用。"""
    global _configured
    if _configured:
        return
    _configured = True
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            # 流被替换成不支持 reconfigure 的对象（如测试桩）时忽略
            try:
                stream.reconfigure(errors="replace")  # type: ignore[call-arg]
            except Exception:
                pass


def safe_print(*args, **kwargs) -> None:
    """永不抛异常的 print：即使流编码异常也不会中断服务进程。"""
    try:
        print(*args, **kwargs)
    except Exception:
        try:
            kwargs.pop("file", None)
            print(*(str(arg).encode("ascii", "replace").decode("ascii") for arg in args), **kwargs)
        except Exception:
            pass
