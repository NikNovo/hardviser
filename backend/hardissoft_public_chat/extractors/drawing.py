"""DXF and SVG drawing extraction."""
import re

from .common import ExtractionError, iter_lines, parse_xml, source_bytes, summary


def _dxf(source):
    lines = iter(iter_lines(source))
    layers, blocks, strings = [], [], []
    section = ''
    entity = ''
    insunits = None
    mtext = []
    while True:
        try:
            code_line = next(lines)
            value_line = next(lines)
        except StopIteration:
            break
        code_text = code_line.strip()
        value = value_line.strip()
        try:
            code = int(code_text)
        except ValueError:
            continue
        if code == 0:
            entity = value.upper()
            if entity in ('ENDSEC', 'ENDTAB', 'EOF'):
                entity = ''
        elif code == 2 and entity == 'SECTION':
            section = value.upper()
        elif code == 2 and entity == 'LAYER':
            layers.append(value)
        elif code == 2 and entity == 'BLOCK':
            blocks.append(value)
        elif section == 'HEADER' and code == 9 and value == '$INSUNITS':
            try:
                next_code, next_value = next(lines), next(lines)
                if int(next_code.strip()) == 70:
                    insunits = next_value.strip()
            except (StopIteration, ValueError):
                pass
        elif section == 'ENTITIES' and entity == 'TEXT' and code == 1 and value:
            strings.append(value)
        elif section == 'ENTITIES' and entity == 'MTEXT' and code in (1, 3) and value:
            mtext.append(value)
        if code == 0 and entity != 'MTEXT' and mtext:
            strings.append(''.join(reversed(mtext)))
            mtext.clear()
    if mtext:
        strings.append(''.join(reversed(mtext)))
    if not (layers or blocks or strings or insunits is not None):
        raise ExtractionError('invalid DXF data')
    units = {'0': 'unitless', '1': 'inches', '2': 'feet', '4': 'millimeters',
             '5': 'centimeters', '6': 'meters'}.get(insunits, 'unknown')
    body = ('Layers: ' + (', '.join(dict.fromkeys(layers)) if layers else 'none found')
            + '\nText: ' + (', '.join(dict.fromkeys(strings)) if strings else 'none found')
            + '\nBlock names: ' + (', '.join(dict.fromkeys(blocks)) if blocks else 'none found')
            + '\n$INSUNITS: ' + (insunits if insunits is not None else 'not declared')
            + ' (' + units + ')')
    return summary('DXF drawing', body)


def _svg(source):
    data = source_bytes(source)
    root = parse_xml(data)
    if root.tag.rsplit('}', 1)[-1].lower() != 'svg':
        raise ExtractionError('invalid SVG document')
    parts = []
    for element in root.iter():
        if element.tag.rsplit('}', 1)[-1].lower() in ('title', 'desc', 'text'):
            text = ' '.join(part.strip() for part in element.itertext() if part and part.strip())
            if text:
                parts.append(text)
    if not parts:
        raise ExtractionError('SVG contains no text')
    return '\n'.join(dict.fromkeys(parts))


def extract(name, source):
    if name.rsplit('.', 1)[-1].lower() == 'svg':
        return _svg(source)
    return _dxf(source)
