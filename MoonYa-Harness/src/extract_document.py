"""Read-only attachment extraction using the already bundled document dependencies."""
import sys, pathlib, json
from zipfile import ZipFile
from xml.etree import ElementTree

path=pathlib.Path(sys.argv[1])
if path.stat().st_size > 32*1024*1024:
    raise ValueError('文档超过本地解析大小限制')
if path.suffix.lower()=='.pdf':
    from pypdf import PdfReader
    text='\n'.join(page.extract_text() or '' for page in PdfReader(path).pages)
elif path.suffix.lower() in ['.docx','.pptx','.xlsx','.odt','.ods','.odp']:
    with ZipFile(path) as archive:
        names=[n for n in archive.namelist() if n in ['word/document.xml','xl/sharedStrings.xml','content.xml'] or n.startswith('ppt/slides/slide') and n.endswith('.xml')]
        if len(names)>500: raise ValueError('文档内容过多')
        text='\n'.join(' '.join(ElementTree.fromstring(archive.read(n)).itertext()) for n in names if archive.getinfo(n).file_size<=32*1024*1024)
else:
    raw=path.read_bytes()
    if b'\0' in raw: raise ValueError('无法提取此文件的文本')
    try: text=raw.decode('utf-8')
    except UnicodeDecodeError: text=raw.decode('gb18030')
print(json.dumps({'text':text},ensure_ascii=True))
