"""Full-text extraction for plain text and PDF documents."""
import json
import subprocess
import sys

from .common import ExtractionError, cap_text, decode_text, parse_xml, source_bytes

PDF_TIMEOUT_SECONDS = 120
PDF_PYTHON = sys.executable
PDF_EXTRACTOR = '''
import json,sys
from pypdf import PdfReader
reader=PdfReader(sys.argv[1], strict=False)
for number,page in enumerate(reader.pages,1):
    print(json.dumps({'page':number,'text':page.extract_text() or ''},ensure_ascii=False))
'''
_TEXT_EXTENSIONS = frozenset({'txt', 'md', 'csv', 'tsv', 'json', 'yaml', 'yml', 'xml', 'log'})


def extract_pdf(path):
    try:
        completed = subprocess.run(
            [PDF_PYTHON, '-c', PDF_EXTRACTOR, str(path)],
            check=False, capture_output=True, text=True, encoding='utf-8', errors='replace',
            timeout=PDF_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise ExtractionError('PDF extraction failed') from None
    if completed.returncode != 0:
        raise ExtractionError('PDF extraction failed')
    pages = []
    try:
        for line in completed.stdout.splitlines():
            item = json.loads(line)
            page = item.get('page')
            text = item.get('text')
            if type(page) is not int or page < 1 or not isinstance(text, str):
                raise ValueError
            pages.append((page, text.replace('\x00', '\ufffd')))
    except (json.JSONDecodeError, TypeError, ValueError):
        raise ExtractionError('PDF extraction failed') from None
    return pages


def extract(name, source):
    extension = name.rsplit('.', 1)[-1].lower()
    if extension not in _TEXT_EXTENSIONS:
        raise ExtractionError('unsupported document format')
    data = source_bytes(source)
    text = decode_text(data)
    if extension == 'xml':
        parse_xml(data)
    return cap_text(text)


def extract_pages(name, source):
    if name.rsplit('.', 1)[-1].lower() == 'pdf':
        return extract_pdf(source)
    return [(None, extract(name, source))]
