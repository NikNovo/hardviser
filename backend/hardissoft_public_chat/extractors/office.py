"""Text extraction for bounded Office Open XML and OpenDocument archives."""
import posixpath
import re

from .common import ExtractionError, local_name, parse_xml, read_member, safe_zip, xml_text


def _by_name(infos):
    return {info.filename: info for info in infos if not info.is_dir()}


def _xml(archive, files, name):
    info = files.get(name)
    if info is None:
        raise ExtractionError('required office document part missing')
    return parse_xml(read_member(archive, info))


def _word(archive, files):
    names = sorted(name for name in files if name.startswith('word/') and name.endswith('.xml'))
    if 'word/document.xml' not in names:
        raise ExtractionError('required office document part missing')
    parts = []
    for name in names:
        root = _xml(archive, files, name)
        texts = [element.text.strip() for element in root.iter()
                 if local_name(element.tag) == 't' and element.text and element.text.strip()]
        if texts:
            parts.append(' '.join(texts))
    return '\n'.join(parts)


def _odt(archive, files):
    root = _xml(archive, files, 'content.xml')
    parts = [xml_text(element) for element in root.iter()
             if local_name(element.tag) in ('p', 'h') and xml_text(element)]
    if not parts:
        raise ExtractionError('OpenDocument text is empty')
    return '\n'.join(parts)


def _slides(archive, files):
    names = sorted((name for name in files
                    if re.fullmatch(r'ppt/slides/slide\d+\.xml', name)),
                   key=lambda name: int(re.search(r'slide(\d+)', name).group(1)))
    if not names:
        raise ExtractionError('required office slide parts missing')
    parts = []
    for index, name in enumerate(names, 1):
        root = _xml(archive, files, name)
        texts = [element.text.strip() for element in root.iter()
                 if local_name(element.tag) == 't' and element.text and element.text.strip()]
        if texts:
            parts.append('Slide %d: %s' % (index, ' '.join(texts)))
    return '\n'.join(parts)


def _shared_strings(archive, files):
    info = files.get('xl/sharedStrings.xml')
    if info is None:
        return []
    root = parse_xml(read_member(archive, info))
    return [xml_text(item) for item in root if local_name(item.tag) == 'si']


def _worksheet_parts(archive, files):
    workbook = _xml(archive, files, 'xl/workbook.xml')
    relationships = {}
    info = files.get('xl/_rels/workbook.xml.rels')
    if info is not None:
        root = parse_xml(read_member(archive, info))
        for item in root:
            if local_name(item.tag) == 'Relationship':
                relationships[item.attrib.get('Id')] = item.attrib.get('Target', '')
    sheets = [item for item in workbook.iter() if local_name(item.tag) == 'sheet']
    if not sheets:
        raise ExtractionError('workbook has no sheets')
    result = []
    for index, sheet in enumerate(sheets, 1):
        title = sheet.attrib.get('name') or ('Sheet %d' % index)
        relationship = next((value for key, value in sheet.attrib.items()
                             if local_name(key) == 'id'), None)
        target = relationships.get(relationship, 'worksheets/sheet%d.xml' % index)
        part = target.lstrip('/') if target.startswith('/') else posixpath.normpath(posixpath.join('xl', target))
        if not part.startswith('xl/') or part not in files:
            raise ExtractionError('worksheet part is unavailable')
        result.append((title, part))
    return result


def _xlsx(archive, files):
    shared = _shared_strings(archive, files)
    parts = []
    for title, name in _worksheet_parts(archive, files):
        root = _xml(archive, files, name)
        parts.append('Sheet: ' + title)
        for row_number, row in enumerate((item for item in root.iter()
                                          if local_name(item.tag) == 'row'), 1):
            values = []
            for cell in row:
                if local_name(cell.tag) != 'c':
                    continue
                kind = cell.attrib.get('t')
                value = next((child.text or '' for child in cell
                              if local_name(child.tag) == 'v'), '')
                if kind == 's':
                    try:
                        value = shared[int(value)]
                    except (ValueError, IndexError):
                        raise ExtractionError('invalid shared string reference') from None
                elif kind == 'inlineStr':
                    inline = next((child for child in cell if local_name(child.tag) == 'is'), None)
                    value = xml_text(inline) if inline is not None else ''
                if value:
                    values.append(value)
            if values:
                parts.append('Row %s: %s' % (row.attrib.get('r', row_number), ' | '.join(values)))
    return '\n'.join(parts)


def _ods(archive, files):
    root = _xml(archive, files, 'content.xml')
    parts = []
    tables = [item for item in root.iter() if local_name(item.tag) == 'table']
    if not tables:
        raise ExtractionError('OpenDocument spreadsheet has no sheets')
    for table in tables:
        name = next((value for key, value in table.attrib.items()
                     if local_name(key) == 'name'), 'Sheet')
        parts.append('Sheet: ' + name)
        for row_number, row in enumerate((item for item in table.iter()
                                          if local_name(item.tag) == 'table-row'), 1):
            values = []
            for cell in row:
                if local_name(cell.tag) not in ('table-cell', 'covered-table-cell'):
                    continue
                repeated = next((value for key, value in cell.attrib.items()
                                 if local_name(key) == 'number-columns-repeated'), '1')
                try:
                    count = min(1000, max(1, int(repeated)))
                except ValueError:
                    count = 1
                value = next((value for key, value in cell.attrib.items()
                              if local_name(key) in ('string-value', 'value')), '')
                value = value or xml_text(cell)
                if value:
                    values.extend([value] * count)
            if values:
                parts.append('Row %d: %s' % (row_number, ' | '.join(values)))
    return '\n'.join(parts)


def extract(name, source):
    extension = name.rsplit('.', 1)[-1].lower()
    with safe_zip(source) as (archive, infos):
        files = _by_name(infos)
        if extension == 'docx':
            return _word(archive, files)
        if extension == 'odt':
            return _odt(archive, files)
        if extension == 'pptx':
            return _slides(archive, files)
        if extension == 'xlsx':
            return _xlsx(archive, files)
        if extension == 'ods':
            return _ods(archive, files)
    raise ExtractionError('unsupported Office format')
