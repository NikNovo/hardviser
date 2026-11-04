"""Server-side file type classification and bounded content extraction."""
from . import cad3d, documents, drawing, image, office, pcb, schematic, stored
from .common import (ExtractionError, MAX_EXTRACTED_TEXT_BYTES, UnsupportedFormat,
                     cap_text, suffix)

EXTENSIONS_BY_KIND = {
    'document': ('pdf', 'txt', 'md', 'csv', 'tsv', 'json', 'yaml', 'yml', 'xml', 'log'),
    'office': ('docx', 'pptx', 'xlsx', 'odt', 'ods'),
    'schematic': ('kicad_sch', 'sch'),
    'pcb': ('kicad_pcb', 'brd', 'gbr', 'ger', 'gtl', 'gbl', 'gto', 'gbo', 'gts', 'gbs',
            'gko', 'gm1', 'drl', 'xln'),
    'cad3d': ('step', 'stp', 'iges', 'igs', 'stl', 'obj', '3mf', 'fcstd'),
    'drawing': ('dxf', 'svg'),
    'image': ('png', 'jpg', 'jpeg', 'webp', 'gif'),
    'stored': ('dwg', 'sldprt', 'sldasm', 'slddrw', 'f3d', 'ipt', 'iam', 'schdoc', 'pcbdoc',
               'prjpcb', 'catpart', 'x_t', 'x_b'),
}
SUPPORTED_EXTENSIONS = frozenset(extension for extensions in EXTENSIONS_BY_KIND.values()
                                 for extension in extensions)
_CONTENT_LEVELS = {
    'document': 'full', 'office': 'full', 'schematic': 'summary', 'pcb': 'summary',
    'cad3d': 'summary', 'drawing': 'summary', 'image': 'summary', 'stored': 'stored',
}
_CONTENT_LEVELS_BY_EXTENSION = {
    extension: _CONTENT_LEVELS[kind]
    for kind, extensions in EXTENSIONS_BY_KIND.items() for extension in extensions
}
_CONTENT_LEVELS_BY_EXTENSION['svg'] = 'full'
_EXTRACTORS = {
    'document': documents.extract, 'office': office.extract, 'schematic': schematic.extract,
    'pcb': pcb.extract, 'cad3d': cad3d.extract, 'drawing': drawing.extract, 'image': image.extract,
}


def classify(name):
    """Return the authoritative ``(kind, content_level)`` for an allowlisted filename."""
    extension = suffix(name)
    kind = next((kind for kind, extensions in EXTENSIONS_BY_KIND.items()
                 if extension in extensions), None)
    if kind is None:
        raise UnsupportedFormat('unsupported file extension')
    return kind, _CONTENT_LEVELS_BY_EXTENSION[extension]


def extract(name, source, *, size_bytes=None, sha256=None):
    kind, level = classify(name)
    if level == 'stored':
        if size_bytes is None or sha256 is None:
            raise ExtractionError('stored file metadata is unavailable')
        text = stored.extract(name, size_bytes, sha256)
    elif kind == 'document' and suffix(name) == 'pdf':
        pages = documents.extract_pdf(source)
        text = '\n'.join(page_text for _, page_text in pages)
    else:
        text = _EXTRACTORS[kind](name, source)
    return cap_text(text)


def extract_pages(name, source, *, size_bytes=None, sha256=None):
    kind, level = classify(name)
    if kind == 'document' and suffix(name) == 'pdf':
        pages = documents.extract_pdf(source)
        bounded, remaining = [], MAX_EXTRACTED_TEXT_BYTES
        for number, text in pages:
            raw = text.encode('utf-8')
            if not remaining:
                break
            clipped = raw[:remaining].decode('utf-8', 'ignore')
            if clipped:
                bounded.append((number, clipped))
                remaining -= len(clipped.encode('utf-8'))
        return bounded
    return [(None, extract(name, source, size_bytes=size_bytes, sha256=sha256))]
