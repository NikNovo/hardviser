import { useId, useLayoutEffect, useRef, useState } from 'react';
import { ChevronRight, MoreHorizontal, Search } from 'lucide-react';
import { CURRENCIES, SCHEMAS, STATUS_ALL } from './records-schema.js';
import { isUnspecified, NARROW_SUMMARY_COLUMNS, RECORD_TABLE_COLUMNS } from './record-table.js';
import './record-table.css';

const NUMBER_FORMATTER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 12 });
const DATE_FORMATTER = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' });
const CURRENCY_FORMATTERS = new Map(
  CURRENCIES.filter(currency => currency !== 'Unknown').map(currency => [
    currency,
    new Intl.NumberFormat('en-US', { style: 'currency', currency }),
  ]),
);

function formatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? NUMBER_FORMATTER.format(number) : String(value);
}

function formatDate(value) {
  const text = String(value);
  const dateParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const date = dateParts
    ? new Date(Number(dateParts[1]), Number(dateParts[2]) - 1, Number(dateParts[3]))
    : new Date(text);
  return Number.isNaN(date.getTime()) ? text : DATE_FORMATTER.format(date);
}

function getValue(record, column) {
  return column.source === 'record' ? record[column.key] : record.fields?.[column.key];
}

function columnLabel(schema, column) {
  if (column.key === 'title') return 'Title';
  if (column.key === 'status') return 'Status';
  return schema.fields.find(field => field.key === column.key)?.label || column.key;
}

function RecordValue({ record, column }) {
  const value = getValue(record, column);
  if (isUnspecified(value)) return <span className="record-table__unknown" title="Not specified"><span aria-hidden="true">—</span><span className="sr-only">Not specified</span></span>;

  if (column.format === 'date') return formatDate(value);
  if (column.format === 'quantity') {
    const unit = record.fields?.[column.relatedKey];
    return `${formatNumber(value)}${isUnspecified(unit) ? '' : ` ${unit}`}`;
  }
  if (column.format === 'currency') {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return String(value);
    const currency = record.fields?.[column.relatedKey];
    const formatter = CURRENCY_FORMATTERS.get(currency);
    if (formatter) return formatter.format(amount);
    const currencyLabel = isUnspecified(currency) || currency === 'Unknown' ? 'currency unknown' : currency;
    return `${formatNumber(value)} (${currencyLabel})`;
  }
  return String(value);
}

function RecordStatus({ record }) {
  return isUnspecified(record.status)
    ? <span className="record-table__unknown" title="Not specified"><span aria-hidden="true">—</span><span className="sr-only">Not specified</span></span>
    : <span className="badge record-table__status">{record.status}</span>;
}

export default function RecordTable({
  kind,
  records,
  totalCount = records.length,
  query,
  status,
  onQueryChange,
  onStatusChange,
  onView,
  renderActions,
}) {
  const schema = SCHEMAS[kind];
  const columns = RECORD_TABLE_COLUMNS[kind] || [];
  const summaryColumn = NARROW_SUMMARY_COLUMNS[kind];
  const id = useId();
  const rootRef = useRef(null);
  const scrollRef = useRef(null);
  const tableRef = useRef(null);
  const [isNarrow, setIsNarrow] = useState(false);
  const [showFullTable, setShowFullTable] = useState(false);
  const [hasOverflow, setHasOverflow] = useState(false);
  const [actionsRecordId, setActionsRecordId] = useState(null);
  const compactList = isNarrow && !showFullTable;

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;

    function updateMeasurements() {
      setIsNarrow(root.clientWidth < 640);
      const region = scrollRef.current;
      setHasOverflow(Boolean(region && region.scrollWidth > region.clientWidth + 1));
    }

    updateMeasurements();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateMeasurements);
    if (observer) {
      observer.observe(root);
      if (scrollRef.current) observer.observe(scrollRef.current);
      if (tableRef.current) observer.observe(tableRef.current);
    } else {
      window.addEventListener('resize', updateMeasurements);
    }
    return () => {
      observer?.disconnect();
      if (!observer) window.removeEventListener('resize', updateMeasurements);
    };
  }, [compactList]);

  function clearFilters() {
    onQueryChange('');
    onStatusChange(STATUS_ALL);
  }

  return (
    <section className="record-table" ref={rootRef} aria-label={schema.plural}>
      <div className="record-table__toolbar">
        <div className="record-table__filters">
          <label className="field" htmlFor={`record-table-search-${id}`}>
            <span>Search records</span>
            <span className="record-table__search-control">
              <Search size={18} aria-hidden="true" />
              <input
                id={`record-table-search-${id}`}
                type="search"
                value={query}
                onChange={event => onQueryChange(event.target.value)}
                placeholder="Title, fields, or status"
              />
            </span>
          </label>
          <label className="field" htmlFor={`record-table-status-${id}`}>
            <span>Status</span>
            <select id={`record-table-status-${id}`} value={status} onChange={event => onStatusChange(event.target.value)}>
              <option value={STATUS_ALL}>All statuses</option>
              {schema.statusOptions.map(option => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>
        </div>
        <div className="record-table__toolbar-meta">
          <p className="record-table__count" aria-live="polite">
            Showing {records.length} of {totalCount} {totalCount === 1 ? 'record' : 'records'}
          </p>
          {isNarrow && (
            <button
              type="button"
              className="button secondary record-table__view-toggle"
              onClick={() => setShowFullTable(value => !value)}
              aria-pressed={showFullTable}
            >
              {showFullTable ? 'Back to list' : 'Full table'}
            </button>
          )}
        </div>
      </div>

      {records.length === 0 ? (
        <div className="empty-state record-table__empty">
          <Search size={20} aria-hidden="true" />
          <h2>No matching records</h2>
          <p>Change the search or status filter to see more records.</p>
          <button type="button" className="button secondary" onClick={clearFilters}>Clear filters</button>
        </div>
      ) : compactList ? (
        <ul className="record-table__list" aria-label={`${schema.plural} records`}>
          {records.map(record => (
            <li className="record-table__list-row" key={record.id}>
              <div className="record-table__list-main">
                <button
                  id={`record-title-${record.id}`}
                  type="button"
                  className="record-table__title-button"
                  onClick={() => onView(record)}
                  aria-label={`View ${record.title || 'Untitled'}`}
                >
                  {record.title || 'Untitled'}
                </button>
                <div className="record-table__list-meta">
                  <RecordStatus record={record} />
                  {summaryColumn && (
                    <span className="record-table__summary">
                      <span>{columnLabel(schema, summaryColumn)}</span>
                      <strong className={summaryColumn.numeric || summaryColumn.mono ? 'record-table__value--numeric' : ''}>
                        <RecordValue record={record} column={summaryColumn} />
                      </strong>
                    </span>
                  )}
                </div>
              </div>
              <button
                type="button"
                className="icon-button record-table__actions-toggle"
                aria-label={`Actions for ${record.title || 'Untitled'}`}
                aria-expanded={actionsRecordId === record.id}
                aria-controls={`record-actions-${id}-${record.id}`}
                onClick={() => setActionsRecordId(current => current === record.id ? null : record.id)}
              >
                <MoreHorizontal size={20} aria-hidden="true" />
              </button>
              <div id={`record-actions-${id}-${record.id}`} className="record-table__list-actions" hidden={actionsRecordId !== record.id}>{renderActions(record)}</div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="record-table__scroll-wrap">
          <div
            className="record-table__scroll"
            ref={scrollRef}
            role="region"
            aria-label={`${schema.plural} full table`}
            tabIndex={0}
          >
            <table className="record-table__table" ref={tableRef}>
              <caption className="sr-only">{schema.plural}</caption>
              <thead>
                <tr>
                  {columns.map(column => (
                    <th
                      key={column.key}
                      scope="col"
                      className={column.identity ? 'record-table__identity' : column.numeric ? 'record-table__numeric' : undefined}
                    >
                      {columnLabel(schema, column)}
                    </th>
                  ))}
                  <th scope="col" className="record-table__action-heading">Actions</th>
                </tr>
              </thead>
              <tbody>
                {records.map(record => (
                  <tr key={record.id}>
                    {columns.map(column => (
                      column.identity ? (
                        <th scope="row" className="record-table__identity" key={column.key}>
                          <button
                            id={`record-title-${record.id}`}
                            type="button"
                            className="record-table__title-button"
                            onClick={() => onView(record)}
                            aria-label={`View ${record.title || 'Untitled'}`}
                          >
                            {record.title || 'Untitled'}
                          </button>
                        </th>
                      ) : column.status ? (
                        <td key={column.key}><RecordStatus record={record} /></td>
                      ) : (
                        <td
                          key={column.key}
                          className={column.numeric ? 'record-table__numeric' : column.mono ? 'record-table__mono' : undefined}
                        >
                          <RecordValue record={record} column={column} />
                        </td>
                      )
                    ))}
                    <td className="record-table__action-cell">
                      <div className="record-table__actions">{renderActions(record)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {hasOverflow && (
            <span className="record-table__scroll-indicator" aria-hidden="true">
              Scroll for more <ChevronRight size={16} />
            </span>
          )}
        </div>
      )}
    </section>
  );
}
