"""Bounded text summaries for STEP, IGES, STL, OBJ, 3MF, and FreeCAD."""
from collections import Counter
import re
import struct

from .common import (ExtractionError, iter_lines, local_name, parse_xml, read_member,
                     safe_zip, source_bytes, summary, xml_text)


def _unique(values):
    result, seen = [], set()
    for value in values:
        value = value.strip()
        if value and value not in seen:
            seen.add(value)
            result.append(value)
    return result


def _step(source):
    header, products = [], []
    in_header = False
    header_seen = False
    for line in iter_lines(source):
        upper = line.upper()
        if 'HEADER;' in upper:
            in_header = True
            header_seen = True
        elif in_header and 'ENDSEC;' in upper:
            in_header = False
        if in_header:
            if any(key in upper for key in ('FILE_NAME', 'FILE_DESCRIPTION', 'FILE_SCHEMA')):
                header.append(line.strip())
        for match in re.finditer(r"\bPRODUCT\s*\(\s*'((?:''|[^'])*)'\s*,\s*'((?:''|[^'])*)'", line, re.IGNORECASE):
            products.append(match.group(2).replace("''", "'"))
    if not header_seen:
        raise ExtractionError('invalid STEP header')
    lines = ['ISO-10303 HEADER:'] + header + ['PRODUCT names: ' + (', '.join(_unique(products)) if products else 'none found')]
    joined_header = '\n'.join(header)
    file_name = re.search(r"FILE_NAME\s*\(\s*'((?:''|[^'])*)'", joined_header, re.IGNORECASE)
    description = re.search(r"FILE_DESCRIPTION\s*\(\s*\(\s*'((?:''|[^'])*)'", joined_header, re.IGNORECASE)
    origin = re.search(r"FILE_NAME\s*\(.*?,.*?,.*?,.*?,.*?,'((?:''|[^'])*)'", joined_header, re.IGNORECASE)
    if file_name:
        lines.append('File name: ' + file_name.group(1).replace("''", "'"))
    if description:
        lines.append('File description: ' + description.group(1).replace("''", "'"))
    if origin:
        lines.append('Originating system: ' + origin.group(1).replace("''", "'"))
    return summary('STEP CAD', '\n'.join(lines))


def _iges(source):
    global_lines, entity_types, start_lines = [], Counter(), []
    directory_line = 0
    for line in iter_lines(source):
        section = line[72:73].upper() if len(line) >= 73 else ''
        content = line[:72].rstrip()
        if section == 'S' and content and len(start_lines) < 8:
            start_lines.append(content)
        elif section == 'G' and content and len(global_lines) < 64:
            global_lines.append(content)
        elif section == 'D':
            directory_line += 1
            if directory_line % 2:
                value = content[:8].strip()
                if value.isdigit():
                    entity_types[value] += 1
    if not start_lines and not global_lines and not entity_types:
        raise ExtractionError('invalid IGES sections')
    counts = ', '.join('%s (%d)' % item for item in sorted(entity_types.items())) or 'none found'
    body = ('Start section: ' + (' | '.join(start_lines) if start_lines else 'not present')
            + '\nGlobal section: ' + (' | '.join(global_lines) if global_lines else 'not present')
            + '\nEntity type counts: ' + counts)
    return summary('IGES CAD', body)


def _stl(source):
    data = source_bytes(source)
    triangle_count = None
    bounds = [float('inf'), float('inf'), float('inf'), float('-inf'), float('-inf'), float('-inf')]
    if len(data) >= 84:
        count = struct.unpack_from('<I', data, 80)[0]
        if len(data) == 84 + count * 50:
            triangle_count = count
            for index in range(count):
                offset = 84 + index * 50 + 12
                coordinates = struct.unpack_from('<9f', data, offset)
                for vertex in range(3):
                    for axis in range(3):
                        value = coordinates[vertex * 3 + axis]
                        low = axis
                        high = axis + 3
                        bounds[low] = min(bounds[low], value)
                        bounds[high] = max(bounds[high], value)
    if triangle_count is None:
        text = data.decode('ascii', 'replace')
        if not text.lstrip().lower().startswith('solid'):
            raise ExtractionError('invalid STL data')
        vertices = [tuple(float(value) for value in match)
                    for match in re.findall(r'\bvertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)', text, re.IGNORECASE)]
        triangle_count = len(re.findall(r'\bfacet\s+normal\b', text, re.IGNORECASE))
        if not triangle_count:
            raise ExtractionError('invalid STL facets')
        for vertex in vertices:
            for axis, value in enumerate(vertex):
                bounds[axis] = min(bounds[axis], value)
                bounds[axis + 3] = max(bounds[axis + 3], value)
    if triangle_count == 0:
        bbox = 'not present'
    elif bounds[0] == float('inf'):
        bbox = 'not present'
    else:
        bbox = '(%g, %g, %g) to (%g, %g, %g) mm' % tuple(bounds)
    return summary('STL CAD', 'Format: %s\nTriangles: %d\nBounding box (mm): %s (units assumed)' % (
        'binary' if len(data) >= 84 and len(data) == 84 + struct.unpack_from('<I', data, 80)[0] * 50 else 'ASCII',
        triangle_count, bbox))


def _obj(source):
    vertices = faces = 0
    names = []
    bounds = [float('inf'), float('inf'), float('inf'), float('-inf'), float('-inf'), float('-inf')]
    for line in iter_lines(source):
        item = line.strip()
        if not item or item.startswith('#'):
            continue
        parts = item.split()
        if parts[0] == 'v' and len(parts) >= 4:
            try:
                point = tuple(float(value) for value in parts[1:4])
            except ValueError:
                continue
            vertices += 1
            for axis, value in enumerate(point):
                bounds[axis] = min(bounds[axis], value)
                bounds[axis + 3] = max(bounds[axis + 3], value)
        elif parts[0] == 'f':
            faces += 1
        elif parts[0] in ('o', 'g') and len(parts) > 1:
            names.append(parts[0] + ': ' + ' '.join(parts[1:]))
    if not vertices and not faces and not names:
        raise ExtractionError('invalid OBJ data')
    bbox = ('(%g, %g, %g) to (%g, %g, %g)' % tuple(bounds)
            if vertices else 'not present')
    return summary('OBJ CAD', 'Objects/groups: %s\nVertices: %d\nFaces: %d\nBounding box: %s' % (
        ', '.join(_unique(names)) if names else 'none found', vertices, faces, bbox))


def _3mf(source):
    with safe_zip(source) as (archive, infos):
        info = next((item for item in infos if item.filename.lower().endswith('.model')
                     and not item.is_dir()), None)
        if info is None:
            raise ExtractionError('3MF model is missing')
        root = parse_xml(read_member(archive, info))
    units = root.attrib.get('unit', 'millimeter')
    names = [element.attrib['name'] for element in root.iter()
             if local_name(element.tag).lower() in ('object', 'component') and element.attrib.get('name')]
    if not names:
        names = [xml_text(element) for element in root.iter()
                 if local_name(element.tag).lower() in ('metadata', 'part') and xml_text(element)]
    return summary('3MF CAD', 'Units: %s\nObjects/parts: %s' % (
        units, ', '.join(_unique(names)) if names else 'none found'))


def _freecad(source):
    with safe_zip(source) as (archive, infos):
        info = next((item for item in infos if item.filename.lower().endswith('document.xml')
                     and not item.is_dir()), None)
        if info is None:
            raise ExtractionError('FreeCAD document metadata is missing')
        root = parse_xml(read_member(archive, info))
    labels = []
    for element in root.iter():
        if local_name(element.tag).lower() == 'property' and element.attrib.get('name', '').casefold() == 'label':
            for child in element.iter():
                if local_name(child.tag).lower() == 'string' and child.attrib.get('value'):
                    labels.append(child.attrib['value'])
    if not labels:
        labels = [value for value in (element.attrib.get('label') for element in root.iter()) if value]
    return summary('FreeCAD document', 'Object labels: ' + (', '.join(_unique(labels)) if labels else 'none found'))


def extract(name, source):
    extension = name.rsplit('.', 1)[-1].lower()
    if extension in ('step', 'stp'):
        return _step(source)
    if extension in ('iges', 'igs'):
        return _iges(source)
    if extension == 'stl':
        return _stl(source)
    if extension == 'obj':
        return _obj(source)
    if extension == '3mf':
        return _3mf(source)
    if extension == 'fcstd':
        return _freecad(source)
    raise ExtractionError('unsupported 3D CAD format')
