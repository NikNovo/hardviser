import { SCHEMAS } from './records-schema.js';
import { RECIPES } from './recipes.js';

const MAX_PROJECT_NAME_CHARACTERS = 200;
const MAX_PROJECT_NAME_BYTES = 800;
const MAX_CONTEXT_CHARACTERS = 8192;
const MAX_CONTEXT_BYTES = 8192;

const PROJECT_FIELDS = [
  ['Description', 'description'],
  ['Product type', 'productType'],
  ['Stage', 'stage'],
  ['Business model', 'model'],
  ['Audience', 'audience'],
  ['Target markets', 'markets'],
  ['Team', 'team'],
  ['Budget', 'budget'],
  ['Currency', 'currency'],
  ['Constraints', 'constraints'],
  ['Next milestone', 'goal'],
  ['Project notes', 'notes'],
  ['Risk flags', 'riskFlags'],
];

function characterBytes(character) {
  const codePoint = character.codePointAt(0);
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function boundedName(value) {
  const chunks = [];
  let characters = 0;
  let bytes = 0;
  let truncated = false;
  for (const character of value) {
    if (characters >= MAX_PROJECT_NAME_CHARACTERS) {
      truncated = true;
      break;
    }
    if (character === '\u0000') {
      truncated = true;
      continue;
    }
    const nextBytes = characterBytes(character);
    if (bytes + nextBytes > MAX_PROJECT_NAME_BYTES) {
      truncated = true;
      break;
    }
    chunks.push(character);
    characters += 1;
    bytes += nextBytes;
  }
  return { value: chunks.join(''), truncated };
}

function isPresent(value) {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(item => typeof item === 'string' && item.trim().length > 0);
  return typeof value === 'number' || typeof value === 'boolean';
}

function primitiveText(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return '';
}

class BoundedText {
  constructor() {
    this.chunks = [];
    this.characterCount = 0;
    this.byteCount = 0;
    this.lineCount = 0;
    this.truncated = false;
    this.full = false;
  }

  append(value) {
    const chunks = [];
    for (const character of value) {
      if (this.characterCount >= MAX_CONTEXT_CHARACTERS) {
        this.truncated = true;
        this.full = true;
        break;
      }
      if (character === '\u0000') {
        this.truncated = true;
        continue;
      }
      const nextBytes = characterBytes(character);
      if (this.byteCount + nextBytes > MAX_CONTEXT_BYTES) {
        this.truncated = true;
        this.full = true;
        break;
      }
      chunks.push(character);
      this.characterCount += 1;
      this.byteCount += nextBytes;
    }
    if (chunks.length) this.chunks.push(chunks.join(''));
    return !this.full;
  }

  line(label, value) {
    if (!isPresent(value)) return;
    if (this.full) {
      this.truncated = true;
      return;
    }
    if (this.lineCount > 0) this.append('\n');
    this.append(`${label}: `);
    if (Array.isArray(value)) {
      let first = true;
      for (const item of value) {
        if (typeof item !== 'string' || !item.trim()) continue;
        if (!first) this.append(', ');
        this.append(item);
        first = false;
        if (this.full) break;
      }
    } else {
      this.append(primitiveText(value));
    }
    this.lineCount += 1;
  }

  get value() {
    return this.chunks.join('');
  }
}

function appendRecord(builder, record) {
  if (!record || typeof record !== 'object') return;
  builder.line(record.type === 'work' ? 'Saved task' : 'Saved record', record.title);
  builder.line('Status', record.status);
  builder.line('Notes', record.notes);

  if (record.type === 'work') {
    const fields = record.fields && typeof record.fields === 'object' ? record.fields : {};
    const recipe = RECIPES.find(item => item.id === fields.recipeId);
    if (recipe) builder.line('Task type', recipe.title);
    for (const field of recipe?.fields || []) {
      builder.line(field.label, fields.inputs?.[field.key]);
      if (builder.full) return;
    }
    for (const entry of Array.isArray(fields.progressLog) ? fields.progressLog : []) {
      if (!entry || typeof entry !== 'object') continue;
      builder.line('Task progress date', entry.date);
      builder.line('Task progress note', entry.text);
      if (builder.full) return;
    }
    return;
  }

  const schema = SCHEMAS[record.type];
  const fields = record.fields && typeof record.fields === 'object' ? record.fields : {};
  for (const field of schema?.fields || []) {
    builder.line(field.label, fields[field.key]);
    if (builder.full) return;
  }
}

export function buildProjectContext(activeProjectId, project, records) {
  if (!activeProjectId || !project || typeof project !== 'object') {
    return { context: null, truncated: false };
  }

  const rawName = typeof project.name === 'string' ? project.name : '';
  const bounded = boundedName(rawName);
  const name = bounded.value.trim() ? bounded.value : 'Untitled project';
  const builder = new BoundedText();
  for (const [label, key] of PROJECT_FIELDS) {
    builder.line(label, project[key]);
    if (builder.full) break;
  }
  if (!builder.full) {
    for (const record of Array.isArray(records) ? records : []) {
      appendRecord(builder, record);
      if (builder.full) break;
    }
  }

  return {
    context: { name, text: builder.value },
    truncated: bounded.truncated || builder.truncated,
  };
}

