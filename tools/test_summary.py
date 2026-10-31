# -*- coding: utf-8 -*-
# BuildSpeechSummary 的 Python 镜像冒烟测试（与 C# 正则语义等价）
import re

RxFencePair = re.compile(r"```[\s\S]*?```")
RxFenceTail = re.compile(r"```[\s\S]*$")
RxInlineCode = re.compile(r"`[^`\n]*`")
RxImage = re.compile(r"!\[[^\]]*\]\([^)]*\)")
RxLink = re.compile(r"\[([^\]]*)\]\([^)]*\)")
RxUrl = re.compile(r"https?://\S+")
RxHtmlTag = re.compile(r"<[^>\n]+>")
RxMdHeading = re.compile(r"^[ \t]{0,3}#{1,6}[ \t]*", re.M)
RxMdBullet = re.compile(r"^[ \t]*[-*+>][ \t]+", re.M)
RxMdOrdered = re.compile(r"^[ \t]*\d+[.)、][ \t]+", re.M)
RxMdHr = re.compile(r"^[ \t]*[-*_]{3,}[ \t]*$", re.M)
RxDateRow = re.compile(r"\d{1,2}[-/月]\d{1,2}|\d{1,2}:\d{2}")
RxHasCjk = re.compile(r"[一-鿿]")
RxSentenceEnd = re.compile(r"[。！？!?]")
RxEnumeration = re.compile(r"、")
RxEmoji = re.compile("(?:[\U0001F000-\U0001FAFF]|[☀-➿⬀-⯿]\ufe0f?|[︀-️])")
RxLeadFiller = re.compile(r"^(好的|好哒|好嘞|嗯|呃|哦)[，,！!～~\s]*")
RxSpaces = re.compile(r"[ \t　]+")
RxTrailClause = re.compile(r"[，,][^，,。！？!?]{0,20}[：:]\s*$")
RxSpaceNearPunct = re.compile(r"\s*([。！？!?～~])\s*")
RxSentenceSplit = re.compile(r"(?<=[。！？!?])")
MAX = 60

def summary(raw):
    t = raw
    t = RxFencePair.sub(" ", t); t = RxFenceTail.sub(" ", t); t = RxInlineCode.sub(" ", t)
    t = RxImage.sub(" ", t); t = RxLink.sub(r"\1", t); t = RxUrl.sub(" ", t)
    t = RxHtmlTag.sub(" ", t); t = RxMdHeading.sub("", t); t = RxMdBullet.sub("", t)
    t = RxMdOrdered.sub("", t); t = RxMdHr.sub(" ", t)

    kept = []
    skip = False
    for raw_line in t.replace("\r", "").split("\n"):
        line = RxSpaces.sub(" ", raw_line.replace("|", " ")).strip()
        if not line:
            skip = False; continue
        if skip:
            skip = False; continue   # 工具输出只跳过紧随的一行，其余交给行规则
        if line.endswith("：") or line.endswith(":"):
            cut = RxTrailClause.sub("", line)
            if cut and cut != line:
                line = cut.strip()
            else:
                skip = True; continue
        if "Agent" in line and not RxSentenceEnd.search(line): continue
        if RxDateRow.search(line) and not RxSentenceEnd.search(line): continue
        if RxEnumeration.search(line) and not RxSentenceEnd.search(line): continue
        if not RxHasCjk.search(line): continue
        if not RxSentenceEnd.search(line) and len(line) <= 15: continue

        if not RxSentenceEnd.search(line): line += "。"   # 保留行缺句号结尾则补上
        kept.append(line)

    flat = " ".join(kept) if kept else RxSpaces.sub(" ", t.replace("\r", " ").replace("\n", " ")).strip()
    flat = RxEmoji.sub("", flat)
    flat = RxLeadFiller.sub("", flat)
    flat = RxSpaces.sub(" ", flat).strip()
    flat = RxSpaceNearPunct.sub(r"\1", flat)   # CJK 标点旁的拼接空格
    if not flat: return ""

    sb = ""
    for s in RxSentenceSplit.split(flat):
        s = s.strip()
        if not s: continue
        if sb and len(sb) + len(s) > MAX: break
        sb += s   # CJK 句子间无需空格
        if len(sb) >= MAX: break
    if not sb:
        sb = flat if len(flat) <= MAX else flat[:MAX].rstrip() + "…"
    elif len(sb) < len(flat) and not RxSentenceEnd.search(sb[-1]):
        sb += "…"
    return sb

f1 = open(r"D:\Project\Project\MoonYa\debug-file1.txt", encoding="utf-8").read()
f2 = open(r"D:\Project\Project\MoonYa\debug-file2.txt", encoding="utf-8").read()
code_reply = "可以，用这个命令：\n```bash\nnpm install && npm run dev\n```\n然后打开 http://localhost:3000 就行。"
pure_code = "```python\nprint('hi')\n```"

for name, text in [("文件1", f1), ("文件2", f2), ("含代码", code_reply), ("纯代码", pure_code)]:
    print(f"── {name} ──")
    print(summary(text) or "(空→显示aiCodeOnly兜底)")
    print()
