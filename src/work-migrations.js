// Old-to-new select-option value migrations for the "work" record kind (recipe inputs).
// Shape: { [recipeId]: { [inputKey]: { [oldRussianOption]: newEnglishOption } } }
// Only covers select fields whose option text actually changed; identical-text options
// (e.g. 'NDA', numeric layer counts) are intentionally omitted.
// Work statuses themselves stay canonical draft/ready/cancelled and are not migrated here.
// Parent calls this only against stored v1 state/imports; it must never mutate free-text
// fields, notes, titles, or old document/work snapshots.

export const WORK_VALUE_MIGRATIONS = {
  'expert-review': {
    desiredFormat: {
      'письменный отзыв': 'written feedback',
      'звонок': 'call',
      'встреча': 'meeting',
    },
  },
  electronics: {
    taskType: {
      'подбор компонентов': 'component selection',
      'схема': 'schematic',
      'предпроверка платы': 'board pre-check',
      'другое': 'other',
    },
  },
  'supplier-search': {
    region: {
      'не определено': 'not specified',
      'Россия': 'Russia',
      'Китай': 'China',
      'ЕС': 'EU',
      'другое': 'other',
    },
  },
  counterparty: {
    scope: {
      'производство': 'manufacturing',
      'поставка материалов': 'material supply',
      'логистика': 'logistics',
      'юридические услуги': 'legal services',
      'другое': 'other',
    },
  },
  mechanical: {
    process: {
      '3D-печать': '3D printing',
      'фрезеровка': 'CNC milling',
      'литьё': 'casting',
      'лазерная резка': 'laser cutting',
      'другое': 'other',
    },
  },
  pcb: {
    layers: {
      'не определено': 'not specified',
    },
  },
  china: {
    requestedAction: {
      'визуальная оценка': 'visual inspection',
      'приёмка': 'acceptance',
      'упаковка': 'packaging',
      'пересылка': 'forwarding',
      'другое': 'other',
    },
    exportRestrictionsKnown: {
      'неизвестно': 'unknown',
      'да': 'yes',
      'нет': 'no',
    },
  },
  patent: {
    taskType: {
      'патентный поиск': 'patent search',
      'подача заявки': 'filing an application',
      'оценка риска нарушения': 'infringement risk assessment',
      'консультация': 'consultation',
    },
  },
  'market-review': {
    categories: {
      'безопасность': 'safety',
      'радио/ЭМС': 'radio/EMC',
      'материалы': 'materials',
      'маркировка': 'labeling',
      'несколько': 'multiple',
    },
  },
  'grant-support': {
    deadlineKnown: {
      'неизвестно': 'unknown',
      'известен': 'known',
    },
    applicationStatus: {
      'не подано': 'not submitted',
      'в подготовке': 'in preparation',
      'подано': 'submitted',
      'отклонено': 'rejected',
      'одобрено': 'approved',
    },
  },
  legal: {
    documentType: {
      'договор разработки': 'development agreement',
      'передача прав': 'rights transfer',
      'договор на оснастку': 'tooling agreement',
    },
  },
};
