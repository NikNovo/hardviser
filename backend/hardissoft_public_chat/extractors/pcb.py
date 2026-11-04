"""PCB summaries for KiCad, Eagle, Gerber, and Excellon files."""
import re

from .common import ExtractionError, local_name, parse_xml, source_bytes, summary

_QUOTED = r'"((?:\\.|[^"\\])*)"'


def _unique(values):
    result = []
    seen = set()
    for value in values:
        value = value.strip()
        if value and value not in seen:
            seen.add(value)
            result.append(value)
    return result


def _block(text, start):
    depth, quoted, escaped = 0, False, False
    for index in range(start, len(text)):
        char = text[index]
        if quoted:
            if escaped:
                escaped = False
            elif char == '\\':
                escaped = True
            elif char == '"':
                quoted = False
        elif char == '"':
            quoted = True
        elif char == '(':
            depth += 1
        elif char == ')':
            depth -= 1
            if depth == 0:
                return text[start:index + 1]
    return text[start:]


def _kicad(data):
    text = data.decode('utf-8', 'replace').replace('\x00', '\ufffd')
    if '(kicad_pcb' not in text[:4096]:
        raise ExtractionError('invalid KiCad PCB')
    parts = []
    for match in re.finditer(r'\((?:footprint|module)\s+' + _QUOTED, text):
        block = _block(text, match.start())
        properties = {key.casefold(): value for key, value in re.findall(
            r'\(property\s+' + _QUOTED + r'\s+' + _QUOTED, block)}
        reference = properties.get('reference', '')
        value = properties.get('value', '')
        if reference or value:
            parts.append('%s: %s' % (reference or 'unreferenced', value or 'no value'))
    layers = []
    layer_match = re.search(r'\(layers\b', text)
    if layer_match:
        layer_block = _block(text, layer_match.start())
        layers = re.findall(r'\(\s*\d+\s+' + _QUOTED, layer_block)
    nets = re.findall(r'\(net\s+\d+\s+' + _QUOTED, text)
    outline_points = []
    for match in re.finditer(r'\(gr_[a-z_]+\b', text):
        block = _block(text, match.start())
        if re.search(r'\(layer\s+"Edge\.Cuts"', block):
            outline_points.extend((float(x), float(y)) for x, y in re.findall(
                r'\((?:start|end|center)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)', block))
    unique_nets = _unique(nets)
    lines = ['Footprints: ' + (', '.join(_unique(parts)) if parts else 'none found'),
             'Layers: ' + (', '.join(_unique(layers)) if layers else 'none found'),
             'Net count: ' + str(len(unique_nets)),
             'Nets: ' + (', '.join(unique_nets) if unique_nets else 'none found')]
    if outline_points:
        xs, ys = [point[0] for point in outline_points], [point[1] for point in outline_points]
        lines.append('Board outline size: %.3f × %.3f mm' % (max(xs) - min(xs), max(ys) - min(ys)))
    else:
        lines.append('Board outline size: not present in excerpt')
    return summary('KiCad PCB', '\n'.join(lines))


def _eagle(data):
    root = parse_xml(data)
    if local_name(root.tag).lower() != 'eagle':
        raise ExtractionError('invalid Eagle board')
    board = next((element for element in root.iter() if local_name(element.tag).lower() == 'board'), None)
    if board is None:
        raise ExtractionError('invalid Eagle board')
    parts, layers, nets = [], [], []
    outline_x, outline_y = [], []
    for element in board.iter():
        tag = local_name(element.tag).lower()
        if tag == 'element':
            name = element.attrib.get('name', '')
            value = element.attrib.get('value', '')
            package = element.attrib.get('package', '')
            parts.append('%s: %s (package %s)' % (name or 'unnamed', value or 'no value', package or 'unknown'))
        elif tag == 'layer' and element.attrib.get('name'):
            layers.append(element.attrib['name'])
        elif tag == 'signal' and element.attrib.get('name'):
            nets.append(element.attrib['name'])
        elif tag == 'wire' and element.attrib.get('layer') == '20':
            for key in ('x1', 'x2'):
                if key in element.attrib:
                    outline_x.append(float(element.attrib[key]))
            for key in ('y1', 'y2'):
                if key in element.attrib:
                    outline_y.append(float(element.attrib[key]))
    unique_nets = _unique(nets)
    lines = ['Footprints: ' + (', '.join(_unique(parts)) if parts else 'none found'),
             'Layers: ' + (', '.join(_unique(layers)) if layers else 'none found'),
             'Net count: ' + str(len(unique_nets)),
             'Nets: ' + (', '.join(unique_nets) if unique_nets else 'none found')]
    if outline_x and outline_y:
        lines.append('Board outline size: %.3f × %.3f mm' % (
            max(outline_x) - min(outline_x), max(outline_y) - min(outline_y)))
    else:
        lines.append('Board outline size: not present in excerpt')
    return summary('Eagle PCB', '\n'.join(lines))


def _gerber(data):
    text = data.decode('ascii', 'replace')
    functions = _unique(re.findall(r'%TF\.FileFunction,([^*%]+)\*%', text, re.IGNORECASE))
    units = 'mm' if re.search(r'%MOMM\*%', text, re.IGNORECASE) else (
        'inch' if re.search(r'%MOIN\*%', text, re.IGNORECASE) else 'unknown')
    apertures = len(re.findall(r'%ADD\d+[A-Z][^%]*%', text, re.IGNORECASE))
    return summary('Gerber PCB layer', 'File function: %s\nUnits: %s\nAperture count: %d' % (
        ', '.join(functions) if functions else 'not declared', units, apertures))


def _excellon(data):
    text = data.decode('ascii', 'replace')
    units = 'metric' if re.search(r'METRIC|M71', text, re.IGNORECASE) else (
        'inch' if re.search(r'INCH|M72', text, re.IGNORECASE) else 'unknown')
    tools = re.findall(r'^\s*T(\d+)\s*C\s*([0-9.]+)', text, re.IGNORECASE | re.MULTILINE)
    coordinates = re.findall(r'^\s*X[+-]?[0-9.]+Y[+-]?[0-9.]+', text, re.IGNORECASE | re.MULTILINE)
    tool_text = ', '.join('%s (%.4g)' % (number, float(diameter)) for number, diameter in tools)
    return summary('Excellon drill', 'Units: %s\nTool table: %s\nHole count: %d' % (
        units, tool_text or 'none found', len(coordinates)))


def extract(name, source):
    extension = name.rsplit('.', 1)[-1].lower()
    data = source_bytes(source)
    if extension == 'kicad_pcb':
        return _kicad(data)
    if extension == 'brd' or data.lstrip().lower().startswith((b'<?xml', b'<eagle')):
        return _eagle(data)
    if extension in {'drl', 'xln'}:
        return _excellon(data)
    return _gerber(data)
