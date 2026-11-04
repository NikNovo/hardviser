// Domain record schemas for HardIsSoft DataPages.
// Every kind below maps 1:1 to a route/record kind from the app contract.
// Fields are declarative so DataPages.jsx can render/validate/export them generically.

export const STATUS_ALL = '__all__';

export const EVIDENCE_LABELS = [
  'Entered by founder',
  'Hypothesis',
  'Confirmed by source',
  'Verified by specialist',
  'Outdated',
  'Conflicting information',
];

export const CURRENCIES = ['RUB', 'USD', 'EUR', 'CNY', 'Unknown'];

function evidencePair(dateLabel) {
  return [
    {
      key: 'evidence',
      label: 'Data reliability status',
      type: 'select',
      options: EVIDENCE_LABELS,
      required: true,
      hint: 'Choose how the information was verified. Add supporting material under Sources; describe who verified it and how in Notes.',
    },
    {
      key: 'evidenceDate',
      label: dateLabel || 'Source/confirmation date',
      type: 'date',
    },
  ];
}

export const SCHEMAS = {
  decision: {
    label: 'Decision',
    plural: 'Decisions',
    pageIntro: "Record key project decisions: what you chose, which options you rejected, and under what condition to revisit the question. This is the founder's decision log, not a chat with the assistant.",
    emptyState: {
      title: 'No decisions recorded yet',
      body: 'Add your first decision: what you decided, which alternatives you considered and rejected, and what event should trigger a review.',
    },
    statusOptions: ['Active', 'Under review', 'Cancelled'],
    summaryKeys: ['decisionDate', 'owner'],
    workLinks: [
      { recipeId: 'expert-review', label: 'Request expert review' },
      { recipeId: 'legal', label: 'Send to lawyer' },
    ],
    fields: [
      { key: 'context', label: 'Context and background', type: 'textarea' },
      { key: 'rejectedAlternatives', label: 'Rejected alternatives and reasons', type: 'textarea', required: true, hint: "Describe what else you considered and why it wasn't chosen" },
      { key: 'revisitTrigger', label: 'When to revisit the decision', type: 'text', hint: 'Event, date, or condition for review' },
      { key: 'decisionDate', label: 'Decision date', type: 'date' },
      { key: 'owner', label: 'Who made the decision', type: 'text' },
    ],
  },

  document: {
    label: 'Document',
    plural: 'Documents',
    pageIntro: 'Project working documents: technical specs, briefs, reports, and meeting minutes maintained by the founder.',
    emptyState: {
      title: 'No documents yet',
      body: 'Add your first working document — specify the type, version, author, and a brief summary.',
    },
    statusOptions: ['Draft', 'In review', 'Approved', 'Outdated'],
    summaryKeys: ['docType', 'docDate'],
    workLinks: [
      { recipeId: 'brief', label: 'Create brief' },
      { recipeId: 'expert-review', label: 'Request expert review' },
    ],
    fields: [
      { key: 'docType', label: 'Document type', type: 'select', required: true, options: ['Technical requirements', 'Brief', 'Report', 'Specification', 'Meeting minutes', 'Other'] },
      { key: 'version', label: 'Version', type: 'text' },
      { key: 'author', label: 'Author', type: 'text' },
      { key: 'docDate', label: 'Document date', type: 'date' },
      { key: 'summary', label: 'Summary', type: 'textarea' },
    ],
  },

  prototype: {
    label: 'Prototype',
    plural: 'Prototypes',
    pageIntro: 'Prototype plan: stages, timelines, and budget for mockups and samples.',
    emptyState: {
      title: 'Prototype plan is empty',
      body: 'Describe your first prototype: goal, stage, planned date, and the assigned expert if already determined.',
    },
    statusOptions: ['Planned', 'In progress', 'Tested', 'Cancelled'],
    summaryKeys: ['stage', 'plannedDate'],
    workLinks: [
      { recipeId: 'prototype-plan', label: 'Request prototype plan' },
      { recipeId: 'mechanical', label: 'Order mechanical prototype' },
      { recipeId: 'pcb', label: 'Order boards/assembly' },
    ],
    moneyPairs: [{ amount: 'budgetEstimate', currency: 'currency' }],
    fields: [
      { key: 'goal', label: 'Prototype goal', type: 'textarea', required: true },
      { key: 'stage', label: 'Stage', type: 'select', required: true, options: ['Concept', 'Mockup', 'Working prototype', 'Pre-production sample'] },
      { key: 'plannedDate', label: 'Planned completion date', type: 'date' },
      { key: 'expertAssigned', label: 'Assigned expert', type: 'text', hint: 'Name/company of the actually engaged expert, if already determined' },
      { key: 'budgetEstimate', label: 'Budget estimate', type: 'number' },
      { key: 'currency', label: 'Currency', type: 'select', options: CURRENCIES },
    ],
  },

  module: {
    label: 'Module / reference',
    plural: 'Modules & references',
    pageIntro: 'Catalog of off-the-shelf modules and reference solutions. Compatibility and licensing are not verified automatically — check before use. Manufacturer links are external reference resources, with no integration.',
    emptyState: {
      title: 'No modules added yet',
      body: 'Record the module under consideration: manufacturer, part number, license status, and information source.',
    },
    statusOptions: ['Under consideration', 'Selected', 'Rejected'],
    summaryKeys: ['manufacturer', 'partNumber'],
    workLinks: [
      { recipeId: 'supplier-search', label: 'Find supplier' },
      { recipeId: 'electronics', label: 'Electronics: request help' },
    ],
    fields: [
      { key: 'category', label: 'Category', type: 'select', required: true, options: ['Electronics', 'Mechanics', 'Software/firmware', 'Enclosure', 'Power', 'Other'] },
      { key: 'manufacturer', label: 'Manufacturer', type: 'text' },
      { key: 'partNumber', label: 'Part number / model', type: 'text' },
      { key: 'licensing', label: 'License status', type: 'select', options: ['Unknown', 'Open license', 'Proprietary', 'Requires approval'] },
      { key: 'compatibilityNotes', label: 'Compatibility notes', type: 'textarea', hint: 'Compatibility is not guaranteed automatically — check before use' },
      ...evidencePair('Verification date'),
    ],
  },

  bom: {
    label: 'BOM item',
    plural: 'Components & BOM',
    pageIntro: 'Bill of materials (BOM): assembly line items, quantities, cost, and status.',
    emptyState: {
      title: 'BOM is empty',
      body: 'Add your first BOM line item: name, quantity, and cost/currency if known.',
    },
    statusOptions: ['Draft', 'Current', 'Outdated'],
    summaryKeys: ['quantity', 'unit'],
    workLinks: [
      { recipeId: 'rfq', label: 'Generate RFQ' },
      { recipeId: 'supplier-search', label: 'Find supplier' },
    ],
    moneyPairs: [{ amount: 'unitCost', currency: 'currency' }],
    fields: [
      { key: 'partNumber', label: 'SKU / part number', type: 'text' },
      { key: 'quantity', label: 'Quantity', type: 'number', required: true, positive: true },
      { key: 'unit', label: 'Unit of measure', type: 'text', hint: 'pcs, m, kg, etc.' },
      { key: 'assembly', label: 'Assembly/unit', type: 'text' },
      { key: 'unitCost', label: 'Unit cost', type: 'number', hint: 'Leave empty if the price is unknown — this is not the same as 0' },
      { key: 'currency', label: 'Currency', type: 'select', options: CURRENCIES },
      { key: 'preferredSupplier', label: 'Preferred supplier (manual)', type: 'text' },
      { key: 'revision', label: 'BOM revision', type: 'text' },
    ],
  },

  test: {
    label: 'Test',
    plural: 'Tests & defects',
    pageIntro: 'Tests and defects tied to a specific specimen and product revision.',
    emptyState: {
      title: 'No tests yet',
      body: 'Record your first test: specimen, method, results, and defects found.',
    },
    statusOptions: ['Planned', 'In progress', 'Completed', 'Failed'],
    summaryKeys: ['specimen', 'testDate'],
    workLinks: [{ recipeId: 'expert-review', label: 'Request expert review' }],
    fields: [
      { key: 'specimen', label: 'Specimen/serial number', type: 'text', required: true },
      { key: 'revision', label: 'Product version/revision', type: 'text' },
      { key: 'method', label: 'Test method', type: 'textarea', required: true },
      { key: 'testDate', label: 'Test date', type: 'date' },
      { key: 'performedBy', label: 'Performed by', type: 'text' },
      { key: 'results', label: 'Results', type: 'textarea', required: true },
      { key: 'defectsFound', label: 'Defects found', type: 'textarea' },
    ],
  },

  supplier: {
    label: 'Supplier',
    plural: 'Suppliers',
    pageIntro: 'List of suppliers and their capabilities for the project.',
    emptyState: {
      title: 'No suppliers added yet',
      body: 'Add a supplier manually: supply category, country, contacts, and capabilities.',
    },
    statusOptions: ['Potential', 'In contact', 'Approved', 'Rejected'],
    summaryKeys: ['category', 'country'],
    workLinks: [
      { recipeId: 'supplier-search', label: 'Find supplier' },
      { recipeId: 'rfq', label: 'Generate RFQ' },
      { recipeId: 'china', label: 'China office: verification' },
    ],
    fields: [
      { key: 'category', label: 'Supply category', type: 'text' },
      { key: 'country', label: 'Country', type: 'text' },
      { key: 'contactName', label: 'Contact person', type: 'text' },
      { key: 'contactInfo', label: 'Contacts (email/phone)', type: 'text' },
      { key: 'capabilities', label: 'Capabilities/specialization', type: 'textarea' },
      { key: 'moq', label: 'Minimum order quantity (MOQ)', type: 'text' },
    ],
  },

  counterparty: {
    label: 'Counterparty',
    plural: 'Counterparty checks',
    pageIntro: 'Counterparty due diligence: scope of the check, date, and established facts — without a universal trust score.',
    emptyState: {
      title: 'No counterparty checks yet',
      body: 'Record a check: who was checked, what exactly was checked, the date, and results.',
    },
    statusOptions: ['Not checked', 'Check started', 'Check completed', 'Risks identified'],
    summaryKeys: ['country', 'verificationDate'],
    workLinks: [{ recipeId: 'counterparty', label: 'Order counterparty check' }],
    fields: [
      { key: 'legalName', label: 'Legal name', type: 'text', required: true },
      { key: 'country', label: 'Country of registration', type: 'text' },
      { key: 'registrationId', label: 'Registration number / Tax ID', type: 'text' },
      { key: 'verificationScope', label: 'Verification scope', type: 'textarea', required: true, hint: 'What exactly was checked: company registry, courts, sanctions lists, etc.' },
      { key: 'verificationDate', label: 'Verification date', type: 'date', required: true },
      { key: 'findings', label: 'Verification findings', type: 'textarea', hint: 'Specific facts, not a trust score' },
      { key: 'unknowns', label: 'Open questions', type: 'textarea' },
      ...evidencePair('Source date'),
    ],
  },

  protection: {
    label: 'Protection measure',
    plural: 'IP & confidentiality',
    pageIntro: 'Development protection: access control and information disclosure — separate from patents and NDAs.',
    emptyState: {
      title: 'No protection measures recorded',
      body: 'Describe the protected asset, type of protection, and who has access.',
    },
    statusOptions: ['Planned', 'Implemented', 'Needs update'],
    summaryKeys: ['protectionType', 'owner'],
    workLinks: [{ recipeId: 'legal', label: 'Send to lawyer' }],
    fields: [
      { key: 'assetDescription', label: 'What is protected', type: 'textarea', required: true },
      { key: 'protectionType', label: 'Protection type', type: 'select', required: true, options: ['Access control', 'NDA', 'Trade secret', 'Disclosure restriction', 'Other'] },
      { key: 'accessScope', label: 'Who has access to what', type: 'textarea' },
      { key: 'owner', label: 'Owner', type: 'text' },
      { key: 'reviewDate', label: 'Next review date', type: 'date' },
    ],
  },

  patent: {
    label: 'Patent',
    plural: 'Patents',
    pageIntro: 'Patents and patent risks: application status, deadlines, and freedom-to-operate (FTO) notes.',
    emptyState: {
      title: 'No patent matters yet',
      body: 'Add the subject of patenting, jurisdiction, and the nearest deadline.',
    },
    statusOptions: ['Searching', 'Preparing application', 'Filed', 'Under examination', 'Granted', 'Rejected'],
    summaryKeys: ['jurisdiction', 'deadline'],
    workLinks: [
      { recipeId: 'patent', label: 'Order patent work' },
      { recipeId: 'legal', label: 'Send to lawyer' },
      { recipeId: 'market-review', label: 'Check market requirements' },
    ],
    fields: [
      { key: 'subject', label: 'Subject of patenting', type: 'text', required: true },
      { key: 'jurisdiction', label: 'Jurisdiction/filing country', type: 'text' },
      { key: 'applicationNumber', label: 'Application number', type: 'text' },
      { key: 'filingDate', label: 'Filing date', type: 'date' },
      { key: 'deadline', label: 'Nearest deadline', type: 'date' },
      { key: 'representative', label: 'Patent attorney', type: 'text', hint: 'Specify the actually engaged specialist' },
      { key: 'riskNotes', label: 'Risk notes (FTO)', type: 'textarea' },
      ...evidencePair('Source date'),
    ],
  },

  contract: {
    label: 'Contract',
    plural: 'Contracts & NDAs',
    pageIntro: 'Contracts and NDAs: who signed, what rights are transferred, and the term.',
    emptyState: {
      title: 'No contracts yet',
      body: 'Add a contract: type, counterparty, and subject of the agreement.',
    },
    statusOptions: ['Draft', 'Under negotiation', 'Signed', 'Terminated'],
    summaryKeys: ['contractType', 'counterpartyName'],
    workLinks: [{ recipeId: 'legal', label: 'Send to lawyer' }],
    fields: [
      { key: 'contractType', label: 'Contract type', type: 'select', required: true, options: ['NDA', 'Development agreement', 'Rights transfer agreement', 'Employment contract', 'Other'] },
      { key: 'counterpartyName', label: 'Counterparty', type: 'text', required: true },
      { key: 'signDate', label: 'Signing date', type: 'date' },
      { key: 'expiryDate', label: 'Expiry date', type: 'date' },
      { key: 'scope', label: 'Scope of agreement', type: 'textarea' },
      { key: 'rightsTransfer', label: 'Rights transfer', type: 'select', options: ['No', 'Partial', 'Full'] },
      ...evidencePair('Source date'),
    ],
  },

  tooling: {
    label: 'Tooling',
    plural: 'Tooling',
    pageIntro: 'Project tooling: molds, dies, and other production tooling, its location, and return terms.',
    emptyState: {
      title: 'No tooling recorded',
      body: 'Describe a tooling item: type, owner, and location.',
    },
    statusOptions: ['In design', 'In production', 'In use', 'In storage', 'Decommissioned'],
    summaryKeys: ['toolingType', 'location'],
    workLinks: [
      { recipeId: 'mechanical', label: 'Order mechanical prototype' },
      { recipeId: 'pcb', label: 'Order boards/assembly' },
      { recipeId: 'supplier-search', label: 'Find supplier' },
    ],
    moneyPairs: [{ amount: 'cost', currency: 'currency' }],
    fields: [
      { key: 'toolingType', label: 'Tooling type', type: 'text', required: true, hint: 'For example: mold, die, jig' },
      { key: 'owner', label: 'Owner', type: 'select', options: ['Company', 'Supplier', 'Shared'] },
      { key: 'location', label: 'Location', type: 'text' },
      { key: 'retrievalTerms', label: 'Return/transfer terms', type: 'textarea' },
      { key: 'cost', label: 'Cost', type: 'number' },
      { key: 'currency', label: 'Currency', type: 'select', options: CURRENCIES },
    ],
  },

  requirement: {
    label: 'Market requirement',
    plural: 'Market requirements',
    pageIntro: 'Market requirements matrix: safety, radio/EMC, materials, and labeling by sales country. Requires a qualified opinion.',
    emptyState: {
      title: 'No market requirements recorded',
      body: 'Add a requirement: market, category, and requirement text.',
    },
    statusOptions: ['Not assessed', 'Needs expert', 'Compliant', 'Non-compliant', 'Not applicable'],
    summaryKeys: ['market', 'category'],
    workLinks: [
      { recipeId: 'market-review', label: 'Order requirements check' },
      { recipeId: 'legal', label: 'Send to lawyer' },
    ],
    fields: [
      { key: 'market', label: 'Market/country', type: 'text', required: true },
      { key: 'category', label: 'Category', type: 'select', required: true, options: ['Safety', 'Radio/EMC', 'Materials', 'Labeling', 'Environment', 'Other'] },
      { key: 'requirementText', label: 'Requirement text', type: 'textarea', required: true },
      { key: 'standard', label: 'Standard/regulation', type: 'text' },
      { key: 'reviewRequired', label: 'Specialist opinion required', type: 'boolean' },
      { key: 'deadline', label: 'Compliance deadline', type: 'date' },
      ...evidencePair('Source date'),
    ],
  },

  expert: {
    label: 'Expert',
    plural: 'Experts',
    pageIntro: 'Project experts — real people with verifiable qualifications, not AI roles.',
    emptyState: {
      title: 'No experts added yet',
      body: 'Record an expert: name, specialization, and contacts — only actually found people.',
    },
    statusOptions: ['Found', 'Contacted', 'Engaged', 'Completed'],
    summaryKeys: ['specialization', 'contactInfo'],
    workLinks: [{ recipeId: 'expert-review', label: 'Request expert review' }],
    moneyPairs: [{ amount: 'hourlyRate', currency: 'currency' }],
    fields: [
      { key: 'fullName', label: 'Expert name', type: 'text', required: true },
      { key: 'specialization', label: 'Specialization', type: 'text', required: true },
      { key: 'qualifications', label: 'Qualifications/proof of experience', type: 'textarea' },
      { key: 'contactInfo', label: 'Contacts', type: 'text' },
      { key: 'hourlyRate', label: 'Hourly rate', type: 'number' },
      { key: 'currency', label: 'Currency', type: 'select', options: CURRENCIES },
    ],
  },

  grant: {
    label: 'Grant program',
    plural: 'Funding programs',
    pageIntro: 'Grants and accelerators: programs, eligibility criteria, and application status. Deadlines are listed only when precisely known.',
    emptyState: {
      title: 'No programs yet',
      body: 'Add a grant program: name, country, and eligibility criteria.',
    },
    statusOptions: ['Program found', 'Application in preparation', 'Submitted', 'Under review', 'Approved', 'Rejected'],
    summaryKeys: ['organizer', 'deadline'],
    workLinks: [{ recipeId: 'grant-support', label: 'Request help with application' }],
    moneyPairs: [{ amount: 'amount', currency: 'currency' }],
    fields: [
      { key: 'programName', label: 'Program name', type: 'text', required: true },
      { key: 'organizer', label: 'Organizer', type: 'text' },
      { key: 'country', label: 'Country/region', type: 'text' },
      { key: 'stageFit', label: 'Suitable project stage', type: 'text' },
      { key: 'eligibility', label: 'Eligibility criteria', type: 'textarea' },
      { key: 'deadline', label: 'Submission deadline', type: 'date', hint: 'Leave empty if the deadline is unknown — do not enter an arbitrary date' },
      { key: 'amount', label: 'Grant amount', type: 'number' },
      { key: 'currency', label: 'Currency', type: 'select', options: CURRENCIES },
    ],
  },

  library: {
    label: 'Library item',
    plural: 'Files & links',
    pageIntro: 'Unified project library: documents, images, recordings, spreadsheets, and links. Files are stored locally in this browser.',
    emptyState: {
      title: 'Library is empty',
      body: 'Upload your first file (up to 20 MB) or add a link entry to an external source.',
    },
    statusOptions: ['Active', 'Archived'],
    summaryKeys: ['docType'],
    workLinks: [{ recipeId: 'investor-pack', label: 'Assemble investor pack' }],
    fields: [
      { key: 'docType', label: 'Material type', type: 'select', required: true, options: ['Document', 'Image', 'Recording', 'Spreadsheet', 'Link', 'Other'] },
      { key: 'description', label: 'Description', type: 'textarea' },
    ],
  },

  observation: {
    label: 'Observation',
    plural: 'Observations',
    pageIntro: 'Observations and insights tied to interviews and evidence sources.',
    emptyState: {
      title: 'No observations yet',
      body: 'Record an observation: what you noticed, in what context, and how confirmed it is.',
    },
    statusOptions: ['New', 'Confirmed', 'Refuted', 'Needs verification'],
    summaryKeys: ['relatedArea', 'observedDate'],
    workLinks: [
      { recipeId: 'expert-review', label: 'Request expert review' },
      { recipeId: 'market-review', label: 'Check market requirements' },
    ],
    fields: [
      { key: 'observationText', label: 'Observation/insight', type: 'textarea', required: true },
      { key: 'context', label: 'Context (interview/source)', type: 'text' },
      { key: 'observedDate', label: 'Observation date', type: 'date' },
      { key: 'relatedArea', label: 'Area', type: 'select', options: ['Demand', 'Technology', 'Production', 'Team', 'Finance', 'Other'] },
      ...evidencePair('Source date'),
    ],
  },
};

const URL_RE = /^https?:\/\//i;

export function formatDate(iso) {
  if (!iso) return 'unknown';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('en-US') + ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

export function formatFieldValue(field, value) {
  if (value === undefined || value === null || value === '') return 'Not specified';
  if (field.type === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

export function emptyFormFor(kind) {
  const schema = SCHEMAS[kind];
  const fields = {};
  schema.fields.forEach((f) => {
    fields[f.key] = f.type === 'boolean' ? false : '';
  });
  const form = { title: '', notes: '', status: schema.statusOptions[0], fields, sources: [] };
  if (kind === 'library') form.fileMeta = null;
  return form;
}

export function recordToForm(record) {
  const schema = SCHEMAS[record.type];
  const fields = { ...(record.fields || {}) };
  schema.fields.forEach((f) => {
    const v = record.fields ? record.fields[f.key] : undefined;
    fields[f.key] = v === undefined || v === null ? (f.type === 'boolean' ? false : '') : v;
  });
  const form = {
    id: record.id,
    title: record.title || '',
    notes: record.notes || '',
    status: record.status || schema.statusOptions[0],
    fields,
    sources: (record.sources || []).map((s) => ({ ...s })),
  };
  if (record.type === 'library') {
    const f = record.fields || {};
    form.fileMeta = f.fileId ? { fileId: f.fileId, fileName: f.fileName, fileSize: f.fileSize, fileMime: f.fileMime } : null;
  }
  return form;
}

export function formToRecord(kind, form) {
  const fields = { ...form.fields };
  if (kind === 'library') {
    if (form.fileMeta) {
      fields.fileId = form.fileMeta.fileId;
      fields.fileName = form.fileMeta.fileName;
      fields.fileSize = form.fileMeta.fileSize;
      fields.fileMime = form.fileMeta.fileMime;
    } else {
      delete fields.fileId;
      delete fields.fileName;
      delete fields.fileSize;
      delete fields.fileMime;
    }
  }
  const record = {
    type: kind,
    title: form.title.trim(),
    notes: form.notes || '',
    status: form.status,
    fields,
    sources: form.sources || [],
  };
  if (form.id) record.id = form.id;
  return record;
}

export function validateRecord(kind, form) {
  const schema = SCHEMAS[kind];
  const errors = {};

  if (!form.title || !form.title.trim()) errors.title = 'Enter a title';

  schema.fields.forEach((f) => {
    const v = form.fields ? form.fields[f.key] : undefined;
    const blank = v === undefined || v === null || v === '';
    if (f.required && f.type !== 'boolean' && blank) {
      errors['field:' + f.key] = 'Required field';
      return;
    }
    if (f.type === 'number' && !blank) {
      const n = Number(v);
      if (Number.isNaN(n)) errors['field:' + f.key] = 'Enter a number';
      else if (f.positive && n <= 0) errors['field:' + f.key] = 'Value must be greater than zero';
    }
  });

  (schema.moneyPairs || []).forEach(({ amount, currency }) => {
    const a = form.fields ? form.fields[amount] : undefined;
    const c = form.fields ? form.fields[currency] : undefined;
    if (a !== undefined && a !== null && a !== '' && (!c || c === 'Unknown')) {
      errors['field:' + currency] = 'Specify a currency when an amount is provided';
    }
  });

  (form.sources || []).forEach((s, i) => {
    if (s.type === 'url') {
      if (!s.url || !URL_RE.test(s.url.trim())) errors['source:' + i] = 'Link must start with http:// or https://';
    } else if (s.type === 'library') {
      if (!s.recordId) errors['source:' + i] = 'Select a library record';
    }
  });

  if (kind === 'library') {
    const docType = form.fields ? form.fields.docType : '';
    if (docType === 'Link') {
      const hasUrl = (form.sources || []).some((s) => s.type === 'url' && s.url);
      if (!hasUrl) errors.libraryContent = 'For a "Link" type entry, add at least one link source';
    } else if (!form.fileMeta || !form.fileMeta.fileId) {
      errors.libraryContent = 'Upload a file (up to 20 MB) or select type "Link"';
    }
  }

  return errors;
}

function csvEscape(v) {
  const s = String(v === undefined || v === null ? '' : v);
  if (/["\n,;]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function toCsvString(rows) {
  return rows.map((r) => r.map(csvEscape).join(',')).join('\r\n');
}

function sourcesToText(sources, libraryRecords) {
  if (!sources || !sources.length) return '';
  return sources
    .map((s) => {
      if (s.type === 'library') {
        const rec = (libraryRecords || []).find((l) => l.id === s.recordId);
        return 'Library: ' + (rec ? rec.title || 'Untitled' : 'record deleted');
      }
      return (s.label ? s.label + ': ' : '') + s.url;
    })
    .join(' | ');
}

export function recordToMarkdown(kind, record, libraryRecords) {
  const schema = SCHEMAS[kind];
  const lines = [];
  lines.push('# ' + (record.title || 'Untitled'));
  lines.push('');
  lines.push('Record type: ' + schema.label);
  lines.push('Status: ' + (record.status || 'Not specified'));
  lines.push('Created: ' + formatDate(record.createdAt));
  lines.push('Updated: ' + formatDate(record.updatedAt));
  lines.push('');
  schema.fields.forEach((f) => {
    lines.push('## ' + f.label);
    lines.push(formatFieldValue(f, record.fields ? record.fields[f.key] : undefined));
    lines.push('');
  });
  if (kind === 'library' && record.fields && record.fields.fileId) {
    lines.push('## Attached file');
    lines.push((record.fields.fileName || 'file') + (record.fields.fileSize ? ' (' + record.fields.fileSize + ' bytes)' : ''));
    lines.push('');
  }
  if (record.notes) {
    lines.push('## Notes');
    lines.push(record.notes);
    lines.push('');
  }
  lines.push('## Sources');
  lines.push(record.sources && record.sources.length ? '' : 'No sources specified');
  (record.sources || []).forEach((s) => {
    if (s.type === 'library') {
      const rec = (libraryRecords || []).find((l) => l.id === s.recordId);
      lines.push('- Library: ' + (rec ? rec.title || 'Untitled' : 'record deleted'));
    } else {
      lines.push('- ' + (s.label ? s.label + ': ' : '') + s.url);
    }
  });
  lines.push('');
  lines.push('_This document was generated locally in the hardviser.com browser from founder-entered data, without AI involvement._');
  return lines.join('\n');
}

export function recordsToCsv(kind, records, libraryRecords) {
  const schema = SCHEMAS[kind];
  const headers = ['Title', 'Status', ...schema.fields.map((f) => f.label), 'Notes', 'Sources', 'Created', 'Updated'];
  const rows = records.map((r) => [
    r.title || '',
    r.status || '',
    ...schema.fields.map((f) => formatFieldValue(f, r.fields ? r.fields[f.key] : undefined)),
    r.notes || '',
    sourcesToText(r.sources, libraryRecords),
    formatDate(r.createdAt),
    formatDate(r.updatedAt),
  ]);
  return toCsvString([headers, ...rows]);
}
