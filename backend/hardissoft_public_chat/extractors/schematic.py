"""Schematic summaries for KiCad S-expressions, legacy text, and Eagle XML."""
import re

from .common import ExtractionError, local_name, parse_xml, source_bytes, summary

_QUOTED = r'"((?:\\.|[^"\\])*)"'


def _unescape(value):
    return re.sub(r'\\(["\\])', r'\1', value)


def _unique(values):
    result = []
    seen = set()
    for value in values:
        value = value.strip()
        if value and value not in seen:
            seen.add(value)
            result.append(value)
    return result


def _render(label, *, parts=(), footprints=(), lib_ids=(), nets=(), title='', sheets=None):
    lines = []
    if title:
        lines.append('Title: ' + title)
    if sheets is not None:
        lines.append('Sheets: ' + str(sheets))
    lines.extend((
        'Parts: ' + (', '.join(parts) if parts else 'none found'),
        'Footprints: ' + (', '.join(footprints) if footprints else 'none found'),
        'Library IDs: ' + (', '.join(lib_ids) if lib_ids else 'none found'),
        'Nets and labels: ' + (', '.join(nets) if nets else 'none found'),
    ))
    return summary(label, '\n'.join(lines))


def _eagle(data):
    root = parse_xml(data)
    if local_name(root.tag).lower() != 'eagle':
        raise ExtractionError('invalid Eagle schematic')
    parts, packages, nets = [], {}, []
    for element in root.iter():
        tag = local_name(element.tag).lower()
        if tag == 'device' and element.attrib.get('name') and element.attrib.get('package'):
            packages[element.attrib['name']] = element.attrib['package']
        elif tag == 'part':
            name = element.attrib.get('name', '')
            value = element.attrib.get('value', '')
            device = element.attrib.get('device', '')
            package = element.attrib.get('package') or packages.get(device, '')
            parts.append('%s: %s (device %s; package %s)' % (
                name or 'unnamed', value or 'no value', device or 'unknown', package or 'unknown'))
        elif tag == 'net' and element.attrib.get('name'):
            nets.append(element.attrib['name'])
    sheets = sum(1 for element in root.iter() if local_name(element.tag).lower() == 'sheet')
    if not any(local_name(element.tag).lower() == 'schematic' for element in root.iter()):
        raise ExtractionError('invalid Eagle schematic')
    return _render('Eagle schematic', parts=_unique(parts), nets=_unique(nets), sheets=sheets)


def _kicad_sexpr(text):
    if '(kicad_sch' not in text[:4096]:
        raise ExtractionError('invalid KiCad schematic')
    properties = [(_unescape(match.group(1)), _unescape(match.group(2)))
                  for match in re.finditer(r'\(property\s+' + _QUOTED + r'\s+' + _QUOTED, text)]
    references = [value for key, value in properties if key.casefold() == 'reference']
    values = [value for key, value in properties if key.casefold() == 'value']
    footprints = [value for key, value in properties if key.casefold() in ('footprint', 'footprint_name')]
    lib_ids = [_unescape(value) for value in re.findall(r'\(lib_id\s+' + _QUOTED, text)]
    labels = [_unescape(value) for value in re.findall(
        r'\((?:label|global_label|hierarchical_label)\s+' + _QUOTED, text)]
    nets = [_unescape(value) for value in re.findall(r'\(net\s+\d+\s+' + _QUOTED, text)]
    title_match = re.search(r'\(title_block\b.*?\(title\s+' + _QUOTED, text, re.DOTALL)
    title = _unescape(title_match.group(1)) if title_match else ''
    part_pairs = []
    for index, reference in enumerate(references):
        value = values[index] if index < len(values) else ''
        part_pairs.append(reference + (': ' + value if value else ''))
    return _render('KiCad schematic', parts=_unique(part_pairs), footprints=_unique(footprints),
                   lib_ids=_unique(lib_ids), nets=_unique(nets + labels), title=title)


def _legacy(text):
    if 'eeschema' not in text[:4096].lower() and '$comp' not in text.lower():
        raise ExtractionError('invalid legacy schematic')
    parts, lib_ids, footprints = [], [], []
    current = {}
    in_component = False
    for line in text.splitlines():
        item = line.strip()
        if item == '$Comp':
            current = {}
            in_component = True
        elif item == '$EndComp':
            if current:
                reference = current.get('reference', '')
                value = current.get('value', '')
                if reference:
                    parts.append(reference + (': ' + value if value else ''))
                if current.get('lib_id'):
                    lib_ids.append(current['lib_id'])
                if current.get('footprint'):
                    footprints.append(current['footprint'])
            in_component = False
        elif in_component:
            lib_match = re.match(r'^L\s+(\S+)\s+(\S+)', item)
            if lib_match:
                current['lib_id'], current['reference'] = lib_match.groups()
            field = re.match(r'^F\s+(\d+)\s+' + _QUOTED, item)
            if field:
                number, value = int(field.group(1)), _unescape(field.group(2))
                if number == 0:
                    current['reference'] = value
                elif number == 1:
                    current['value'] = value
                elif number == 2:
                    current['footprint'] = value
    title_match = re.search(r'(?mi)^Title\s+"?([^"\r\n]+)', text)
    title = title_match.group(1).strip() if title_match else ''
    return _render('KiCad legacy schematic', parts=_unique(parts), footprints=_unique(footprints),
                   lib_ids=_unique(lib_ids), title=title)


def extract(name, source):
    data = source_bytes(source)
    prefix = data[:4096].lstrip().lower()
    if prefix.startswith(b'<?xml') or b'<eagle' in prefix:
        return _eagle(data)
    text = data.decode('utf-8', 'replace').replace('\x00', '\ufffd')
    if '(kicad_sch' in text[:4096]:
        return _kicad_sexpr(text)
    if name.rsplit('.', 1)[-1].lower() == 'sch':
        return _legacy(text)
    raise ExtractionError('invalid KiCad schematic')
