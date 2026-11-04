"""Read image format and dimensions from bounded file headers (no OCR)."""
import struct

from .common import ExtractionError, source_bytes, summary

_SOF = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}


def _jpeg(data):
    if not data.startswith(b'\xff\xd8'):
        raise ExtractionError('invalid JPEG header')
    index = 2
    while index + 4 <= len(data):
        if data[index] != 0xff:
            index += 1
            continue
        while index < len(data) and data[index] == 0xff:
            index += 1
        if index >= len(data):
            break
        marker = data[index]
        index += 1
        if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7 or marker == 0x01:
            continue
        if index + 2 > len(data):
            break
        size = struct.unpack_from('>H', data, index)[0]
        if size < 2 or index + size > len(data):
            break
        if marker in _SOF and size >= 7:
            height, width = struct.unpack_from('>HH', data, index + 3)
            if width and height:
                return width, height
        index += size
    raise ExtractionError('JPEG dimensions are unavailable')


def _webp(data):
    if len(data) < 21 or data[:4] != b'RIFF' or data[8:12] != b'WEBP':
        raise ExtractionError('invalid WebP header')
    chunk = data[12:16]
    if chunk == b'VP8X' and len(data) >= 30:
        return (1 + int.from_bytes(data[24:27], 'little'),
                1 + int.from_bytes(data[27:30], 'little'))
    if chunk == b'VP8L' and len(data) >= 25 and data[20] == 0x2f:
        bits = int.from_bytes(data[21:25], 'little')
        return ((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
    if chunk == b'VP8 ' and len(data) >= 30 and data[23:26] == b'\x9d\x01\x2a':
        width, height = struct.unpack_from('<HH', data, 26)
        return width & 0x3fff, height & 0x3fff
    raise ExtractionError('WebP dimensions are unavailable')


def extract(name, source):
    data = source_bytes(source, limit=1024 * 1024)
    extension = name.rsplit('.', 1)[-1].lower()
    if extension == 'png':
        if len(data) < 24 or data[:8] != b'\x89PNG\r\n\x1a\n' or data[12:16] != b'IHDR':
            raise ExtractionError('invalid PNG header')
        width, height = struct.unpack_from('>II', data, 16)
        format_name = 'PNG'
    elif extension == 'gif':
        if len(data) < 10 or data[:6] not in (b'GIF87a', b'GIF89a'):
            raise ExtractionError('invalid GIF header')
        width, height = struct.unpack_from('<HH', data, 6)
        format_name = 'GIF'
    elif extension in ('jpg', 'jpeg'):
        width, height = _jpeg(data)
        format_name = 'JPEG'
    elif extension == 'webp':
        width, height = _webp(data)
        format_name = 'WebP'
    else:
        raise ExtractionError('unsupported image format')
    if not width or not height:
        raise ExtractionError('image dimensions are invalid')
    return summary('Image', '%s, %d × %d pixels; no OCR performed' % (format_name, width, height))
