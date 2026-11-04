// Old (Russian, v1) -> new (English) value migration map for DataPages records.
// Parent slice applies this only to v1 stored state/imports, matched per record
// kind + status/field, never as a global text replacement. Free-text fields,
// notes, and record titles are never touched by this map.

// Shared select options reused verbatim across several kinds (see
// records-schema.js `evidencePair()` / `CURRENCIES`). Spread into each kind
// below rather than referenced globally, per the per-kind/per-field contract.
const EVIDENCE_OPTION_MIGRATION = {
  'Введено фаундером': 'Entered by founder',
  'Гипотеза': 'Hypothesis',
  'Подтверждено источником': 'Confirmed by source',
  'Проверено специалистом': 'Verified by specialist',
  'Устарело': 'Outdated',
  'Есть противоречие': 'Conflicting information',
};

const CURRENCY_OPTION_MIGRATION = {
  'Неизвестно': 'Unknown',
};

export const RECORD_VALUE_MIGRATIONS = {
  decision: {
    status: {
      'Действует': 'Active',
      'На пересмотре': 'Under review',
      'Отменено': 'Cancelled',
    },
  },

  document: {
    status: {
      'Черновик': 'Draft',
      'На проверке': 'In review',
      'Утверждён': 'Approved',
      'Устарел': 'Outdated',
    },
    fields: {
      docType: {
        'Техническое задание': 'Technical requirements',
        'Бриф': 'Brief',
        'Отчёт': 'Report',
        'Спецификация': 'Specification',
        'Протокол встречи': 'Meeting minutes',
        'Другое': 'Other',
      },
    },
  },

  prototype: {
    status: {
      'Планируется': 'Planned',
      'В работе': 'In progress',
      'Испытан': 'Tested',
      'Отменён': 'Cancelled',
    },
    fields: {
      stage: {
        'Концепт': 'Concept',
        'Макет': 'Mockup',
        'Рабочий прототип': 'Working prototype',
        'Предсерийный образец': 'Pre-production sample',
      },
      currency: { ...CURRENCY_OPTION_MIGRATION },
    },
  },

  module: {
    status: {
      'Рассматривается': 'Under consideration',
      'Выбран': 'Selected',
      'Отклонён': 'Rejected',
    },
    fields: {
      category: {
        'Электроника': 'Electronics',
        'Механика': 'Mechanics',
        'ПО/прошивка': 'Software/firmware',
        'Корпус': 'Enclosure',
        'Питание': 'Power',
        'Другое': 'Other',
      },
      licensing: {
        'Неизвестно': 'Unknown',
        'Открытая лицензия': 'Open license',
        'Проприетарная': 'Proprietary',
        'Требует согласования': 'Requires approval',
      },
      evidence: { ...EVIDENCE_OPTION_MIGRATION },
    },
  },

  bom: {
    status: {
      'Черновик': 'Draft',
      'Актуальный': 'Current',
      'Устаревший': 'Outdated',
    },
    fields: {
      currency: { ...CURRENCY_OPTION_MIGRATION },
    },
  },

  test: {
    status: {
      'Запланировано': 'Planned',
      'Выполняется': 'In progress',
      'Завершено': 'Completed',
      'Провалено': 'Failed',
    },
  },

  supplier: {
    status: {
      'Потенциальный': 'Potential',
      'На связи': 'In contact',
      'Одобрен': 'Approved',
      'Отклонён': 'Rejected',
    },
  },

  counterparty: {
    status: {
      'Не проверен': 'Not checked',
      'Проверка начата': 'Check started',
      'Проверка завершена': 'Check completed',
      'Выявлены риски': 'Risks identified',
    },
    fields: {
      evidence: { ...EVIDENCE_OPTION_MIGRATION },
    },
  },

  protection: {
    status: {
      'Планируется': 'Planned',
      'Внедрено': 'Implemented',
      'Требует обновления': 'Needs update',
    },
    fields: {
      protectionType: {
        'Контроль доступа': 'Access control',
        'NDA': 'NDA',
        'Служебная тайна': 'Trade secret',
        'Ограничение раскрытия': 'Disclosure restriction',
        'Другое': 'Other',
      },
    },
  },

  patent: {
    status: {
      'Поиск': 'Searching',
      'Подготовка заявки': 'Preparing application',
      'Подана': 'Filed',
      'На экспертизе': 'Under examination',
      'Выдан': 'Granted',
      'Отказ': 'Rejected',
    },
    fields: {
      evidence: { ...EVIDENCE_OPTION_MIGRATION },
    },
  },

  contract: {
    status: {
      'Черновик': 'Draft',
      'На согласовании': 'Under negotiation',
      'Подписан': 'Signed',
      'Расторгнут': 'Terminated',
    },
    fields: {
      contractType: {
        'NDA': 'NDA',
        'Договор разработки': 'Development agreement',
        'Договор на передачу прав': 'Rights transfer agreement',
        'Трудовой договор': 'Employment contract',
        'Другое': 'Other',
      },
      rightsTransfer: {
        'Нет': 'No',
        'Частично': 'Partial',
        'Полностью': 'Full',
      },
      evidence: { ...EVIDENCE_OPTION_MIGRATION },
    },
  },

  tooling: {
    status: {
      'В проектировании': 'In design',
      'Изготавливается': 'In production',
      'В эксплуатации': 'In use',
      'На хранении': 'In storage',
      'Списана': 'Decommissioned',
    },
    fields: {
      owner: {
        'Компания': 'Company',
        'Поставщик': 'Supplier',
        'Совместно': 'Shared',
      },
      currency: { ...CURRENCY_OPTION_MIGRATION },
    },
  },

  requirement: {
    status: {
      'Не оценено': 'Not assessed',
      'Требует эксперта': 'Needs expert',
      'Соответствует': 'Compliant',
      'Не соответствует': 'Non-compliant',
      'Неприменимо': 'Not applicable',
    },
    fields: {
      category: {
        'Безопасность': 'Safety',
        'Радио/ЭМС': 'Radio/EMC',
        'Материалы': 'Materials',
        'Маркировка': 'Labeling',
        'Экология': 'Environment',
        'Другое': 'Other',
      },
      evidence: { ...EVIDENCE_OPTION_MIGRATION },
    },
  },

  expert: {
    status: {
      'Найден': 'Found',
      'Контакт установлен': 'Contacted',
      'Сотрудничество': 'Engaged',
      'Завершено': 'Completed',
    },
    fields: {
      currency: { ...CURRENCY_OPTION_MIGRATION },
    },
  },

  grant: {
    status: {
      'Найдена программа': 'Program found',
      'Готовится заявка': 'Application in preparation',
      'Подана': 'Submitted',
      'На рассмотрении': 'Under review',
      'Одобрена': 'Approved',
      'Отклонена': 'Rejected',
    },
    fields: {
      currency: { ...CURRENCY_OPTION_MIGRATION },
    },
  },

  library: {
    status: {
      'Активен': 'Active',
      'Архив': 'Archived',
    },
    fields: {
      docType: {
        'Документ': 'Document',
        'Изображение': 'Image',
        'Запись': 'Recording',
        'Таблица': 'Spreadsheet',
        'Ссылка': 'Link',
        'Другое': 'Other',
      },
    },
  },

  observation: {
    status: {
      'Новое': 'New',
      'Подтверждено': 'Confirmed',
      'Опровергнуто': 'Refuted',
      'Требует проверки': 'Needs verification',
    },
    fields: {
      relatedArea: {
        'Спрос': 'Demand',
        'Технология': 'Technology',
        'Производство': 'Production',
        'Команда': 'Team',
        'Финансы': 'Finance',
        'Другое': 'Other',
      },
      evidence: { ...EVIDENCE_OPTION_MIGRATION },
    },
  },
};
