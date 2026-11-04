export const UPLOAD_CHUNK_BYTES = 2 * 1024 * 1024;
export const MAX_PENDING_ANSWER_AGE_MS = 90_000;
export const MAX_UPLOAD_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TODO_CHARACTERS = 2000;
export const MAX_TODO_BYTES = 8000;

export function unicodeCharacterCount(value) {
  let count = 0;
  for (const character of String(value ?? '')) count += 1;
  return count;
}

export function unicodePrefix(value, maxCharacters = 20) {
  const text = String(value ?? '');
  if (!Number.isInteger(maxCharacters) || maxCharacters <= 0) return '';
  let end = 0;
  let count = 0;
  for (const character of text) {
    end += character.length;
    if (++count >= maxCharacters) break;
  }
  return text.slice(0, end);
}

export function truncateTodoText(value) {
  const text = String(value ?? '');
  let result = '';
  let characterCount = 0;
  let byteCount = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    const characterBytes = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (characterCount >= MAX_TODO_CHARACTERS || byteCount + characterBytes > MAX_TODO_BYTES) break;
    result += character;
    characterCount += 1;
    byteCount += characterBytes;
  }
  return { text: result, truncated: result.length !== text.length };
}

export function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Size unknown';
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function fileContentHint(file) {
  if (file?.content_level === 'stored' || file?.kind === 'stored') return 'Stored only · content not readable';
  if (file?.content_level === 'summary') return 'Summary only · ready to mention';
  return 'Extracted text · ready to mention';
}
export function fileStatusHint(file) {
  if (file?.status === 'ready') return fileContentHint(file);
  if (file?.status === 'pending') return 'Processing';
  if (file?.status === 'failed') {
    const reason = file.error === 'empty'
      ? 'No readable text'
      : file.error === 'extract_failed'
        ? 'Text extraction failed'
        : 'Processing failed';
    return `Failed · ${reason}`;
  }
  return file?.status || 'Unknown status';
}

export const SUPPORTED_FILE_FORMAT_GROUPS = Object.freeze([
  Object.freeze({ kind: 'document', label: 'Document', extensions: Object.freeze(['pdf', 'txt', 'md', 'csv', 'tsv', 'json', 'yaml', 'yml', 'xml', 'log']) }),
  Object.freeze({ kind: 'office', label: 'Office', extensions: Object.freeze(['docx', 'pptx', 'xlsx', 'odt', 'ods']) }),
  Object.freeze({ kind: 'schematic', label: 'Schematic', extensions: Object.freeze(['kicad_sch', 'sch']) }),
  Object.freeze({ kind: 'pcb', label: 'PCB', extensions: Object.freeze(['kicad_pcb', 'brd', 'gbr', 'ger', 'gtl', 'gbl', 'gto', 'gbo', 'gts', 'gbs', 'gko', 'gm1', 'drl', 'xln']) }),
  Object.freeze({ kind: 'cad3d', label: '3D CAD', extensions: Object.freeze(['step', 'stp', 'iges', 'igs', 'stl', 'obj', '3mf', 'fcstd']) }),
  Object.freeze({ kind: 'drawing', label: 'Drawing', extensions: Object.freeze(['dxf', 'svg']) }),
  Object.freeze({ kind: 'image', label: 'Image', extensions: Object.freeze(['png', 'jpg', 'jpeg', 'webp', 'gif']) }),
  Object.freeze({ kind: 'stored', label: 'Stored', extensions: Object.freeze(['dwg', 'sldprt', 'sldasm', 'slddrw', 'f3d', 'ipt', 'iam', 'schdoc', 'pcbdoc', 'prjpcb', 'catpart', 'x_t', 'x_b']) }),
]);

export const SUPPORTED_FILE_EXTENSIONS = Object.freeze(
  SUPPORTED_FILE_FORMAT_GROUPS.flatMap(group => group.extensions),
);
export const FILE_INPUT_ACCEPT = SUPPORTED_FILE_EXTENSIONS.map(extension => `.${extension}`).join(',');

const FILE_KIND_BY_EXTENSION = Object.fromEntries(
  SUPPORTED_FILE_FORMAT_GROUPS.flatMap(({ kind, extensions }) => extensions.map(extension => [extension, kind])),
);

export function classifyFileExtension(fileName) {
  if (typeof fileName !== 'string') return null;
  const separatorIndex = fileName.lastIndexOf('.');
  if (separatorIndex < 0 || separatorIndex === fileName.length - 1) return null;
  const extension = fileName.slice(separatorIndex + 1).toLowerCase();
  return Object.hasOwn(FILE_KIND_BY_EXTENSION, extension) ? FILE_KIND_BY_EXTENSION[extension] : null;
}

export function getMentionQuery(text, caret = text.length) {
  if (typeof text !== 'string' || !Number.isInteger(caret)) return null;
  const position = Math.max(0, Math.min(caret, text.length));
  const start = text.lastIndexOf('@', position);
  if (start < 0 || /[\p{L}\p{N}_@]/u.test(text[start - 1] || '')) return null;

  for (let index = start + 1; index < position; index += 1) {
    if (/\s|@/u.test(text[index])) return null;
  }
  let end = position;
  while (end < text.length && !/[\s@]/u.test(text[end])) end += 1;
  return { start, end, query: text.slice(start + 1, end) };
}

export function replaceMentionQuery(text, match) {
  if (typeof text !== 'string' || !match
    || !Number.isInteger(match.start) || !Number.isInteger(match.end)
    || match.start < 0 || match.end < match.start || match.end > text.length) return text;
  const before = text.slice(0, match.start);
  let after = text.slice(match.end);
  if (/\s$/u.test(before) && /^\s/u.test(after)) after = after.slice(1);
  return before + after;
}

export function splitUploadChunks(bytes, chunkBytes = UPLOAD_CHUNK_BYTES) {
  if (!(bytes instanceof Uint8Array) || !Number.isInteger(chunkBytes) || chunkBytes <= 0) {
    throw new RangeError('Upload bytes and chunk size must be valid.');
  }
  const chunks = [];
  for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
    chunks.push(bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.byteLength)));
  }
  return chunks;
}

export function findPendingAnswer(messages, now = Date.now(), maxAgeMs = MAX_PENDING_ANSWER_AGE_MS) {
  if (!Array.isArray(messages) || !messages.length) return null;
  const last = messages[messages.length - 1];
  if (last?.role !== 'user' || typeof last.created_at !== 'string') return null;
  const createdAt = Date.parse(last.created_at);
  const age = now - createdAt;
  return Number.isFinite(createdAt) && age >= 0 && age < maxAgeMs ? last : null;
}
