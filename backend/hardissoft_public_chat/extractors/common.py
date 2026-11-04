"""Shared bounded input, archive, XML, and summary helpers for file extractors."""
from contextlib import contextmanager
import io
from pathlib import Path
import re
import zipfile
import xml.etree.ElementTree as ET

MAX_ARCHIVE_MEMBERS = 2000
MAX_ARCHIVE_BYTES = 200 * 1024 * 1024
MAX_EXTRACTED_TEXT_BYTES = 2 * 1024 * 1024
_MEMBER_READ_BYTES = MAX_ARCHIVE_BYTES


class ExtractionError(RuntimeError):
    """A readable file could not be parsed safely."""


class UnsupportedFormat(ValueError):
    """The upload filename does not have an allowlisted extension."""


def suffix(name):
    return Path(name).suffix.lower().lstrip('.')


def source_bytes(source, *, limit=None):
    if isinstance(source, bytes):
        data = source
    elif isinstance(source, bytearray):
        data = bytes(source)
    elif isinstance(source, (str, Path)):
        try:
            with open(source, 'rb') as stream:
                data = stream.read() if limit is None else stream.read(limit + 1)
        except OSError:
            raise ExtractionError('source file unavailable') from None
    else:
        raise TypeError('source must be bytes or a filesystem path')
    if limit is not None and len(data) > limit:
        raise ExtractionError('source exceeds its extraction limit')
    return data


def iter_lines(source):
    if isinstance(source, (str, Path)):
        try:
            with open(source, 'r', encoding='utf-8', errors='replace', newline=None) as stream:
                yield from stream
        except OSError:
            raise ExtractionError('source file unavailable') from None
        return
    data = source_bytes(source)
    yield from io.TextIOWrapper(io.BytesIO(data), encoding='utf-8', errors='replace', newline=None)


def decode_text(data):
    return data.decode('utf-8', 'replace').replace('\x00', '\ufffd')


def cap_text(text, maximum=MAX_EXTRACTED_TEXT_BYTES):
    encoded = text.encode('utf-8')
    if len(encoded) <= maximum:
        return text
    return encoded[:maximum].decode('utf-8', 'ignore')


def summary(label, body):
    return '[' + label + ' summary — not the full design]\n' + body


def _safe_member(info):
    name = info.filename.replace('\\', '/')
    if (name.startswith('/') or re.match(r'^[A-Za-z]:', name)
            or any(part == '..' for part in name.split('/'))):
        return False
    return True


@contextmanager
def safe_zip(source):
    try:
        archive = zipfile.ZipFile(io.BytesIO(source_bytes(source)))
    except (OSError, zipfile.BadZipFile, zipfile.LargeZipFile):
        raise ExtractionError('invalid archive') from None
    try:
        infos = archive.infolist()
        if len(infos) > MAX_ARCHIVE_MEMBERS or any(not _safe_member(info) for info in infos):
            raise ExtractionError('unsafe archive')
        if sum(info.file_size for info in infos) > MAX_ARCHIVE_BYTES:
            raise ExtractionError('archive limits exceeded')
        yield archive, infos
    finally:
        archive.close()


def read_member(archive, info):
    if info.file_size < 0 or info.file_size > _MEMBER_READ_BYTES:
        raise ExtractionError('archive limits exceeded')
    try:
        with archive.open(info) as stream:
            chunks = []
            total = 0
            while True:
                block = stream.read(min(1024 * 1024, _MEMBER_READ_BYTES - total + 1))
                if not block:
                    break
                total += len(block)
                if total > _MEMBER_READ_BYTES or total > info.file_size:
                    raise ExtractionError('archive limits exceeded')
                chunks.append(block)
    except (OSError, RuntimeError, zipfile.BadZipFile, EOFError):
        raise ExtractionError('invalid archive member') from None
    if total != info.file_size:
        raise ExtractionError('invalid archive member')
    return b''.join(chunks)


def parse_xml(data):
    lowered = data.replace(b'\x00', b'').lower()
    if b'<!doctype' in lowered or b'<!entity' in lowered:
        raise ExtractionError('unsafe XML')
    try:
        return ET.fromstring(data)
    except (ET.ParseError, ValueError):
        raise ExtractionError('invalid XML') from None


def local_name(tag):
    return tag.rsplit('}', 1)[-1].split(':')[-1]


def xml_text(element):
    return ' '.join(part.strip() for part in element.itertext() if part and part.strip())
