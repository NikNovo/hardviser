import { STATUS_ALL } from './records-schema.js';

export const RECORD_TABLE_COLUMNS = {
  bom: [
    { key: 'title', source: 'record', identity: true },
    { key: 'status', source: 'record', status: true },
    { key: 'partNumber' },
    { key: 'quantity', relatedKey: 'unit', format: 'quantity', numeric: true },
    { key: 'unitCost', relatedKey: 'currency', format: 'currency', numeric: true },
    { key: 'preferredSupplier' },
    { key: 'revision', mono: true },
  ],
  document: [
    { key: 'title', source: 'record', identity: true },
    { key: 'docType' },
    { key: 'version', mono: true },
    { key: 'author' },
    { key: 'docDate', format: 'date' },
    { key: 'status', source: 'record', status: true },
  ],
  test: [
    { key: 'title', source: 'record', identity: true },
    { key: 'specimen', mono: true },
    { key: 'revision', mono: true },
    { key: 'testDate', format: 'date' },
    { key: 'performedBy' },
    { key: 'status', source: 'record', status: true },
  ],
  supplier: [
    { key: 'title', source: 'record', identity: true },
    { key: 'category' },
    { key: 'country' },
    { key: 'contactName' },
    { key: 'contactInfo' },
    { key: 'status', source: 'record', status: true },
  ],
};

export const NARROW_SUMMARY_COLUMNS = {
  bom: { key: 'quantity', relatedKey: 'unit', format: 'quantity', numeric: true },
  document: { key: 'version', mono: true },
  test: { key: 'testDate', format: 'date' },
  supplier: { key: 'category' },
};

export function isUnspecified(value) {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

function matchesQuery(record, columns, query) {
  for (const column of columns) {
    const value = column.source === 'record' ? record[column.key] : record.fields?.[column.key];
    if (!isUnspecified(value) && String(value).toLocaleLowerCase('en-US').includes(query)) return true;

    if (column.relatedKey) {
      const relatedValue = record.fields?.[column.relatedKey];
      if (!isUnspecified(relatedValue) && String(relatedValue).toLocaleLowerCase('en-US').includes(query)) return true;
    }
  }
  return false;
}

export function filterTableRecords(kind, records, filters) {
  const columns = RECORD_TABLE_COLUMNS[kind] || [];
  const query = (filters.query || '').trim().toLocaleLowerCase('en-US');
  const status = filters.status;

  return records.filter(record => {
    if (status && status !== STATUS_ALL && record.status !== status) return false;
    return !query || matchesQuery(record, columns, query);
  });
}
