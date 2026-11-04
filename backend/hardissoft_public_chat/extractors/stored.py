"""A searchable metadata-only chunk for proprietary formats we cannot read."""
import re


def extract(name, size_bytes, sha256):
    if type(size_bytes) is not int or size_bytes < 0:
        raise ValueError('stored file size is invalid')
    if not isinstance(sha256, str) or re.fullmatch(r'[a-f0-9]{64}', sha256) is None:
        raise ValueError('stored file digest is invalid')
    extension = name.rsplit('.', 1)[-1].upper()
    return ('[Stored %s — content not readable]\nName: %s\nKind: stored\nSize: %d bytes\nSHA-256: %s' %
            (extension, name, size_bytes, sha256[:16]))
