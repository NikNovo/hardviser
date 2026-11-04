import { RECORD_VALUE_MIGRATIONS } from './record-migrations.js';
import { WORK_VALUE_MIGRATIONS } from './work-migrations.js';

const PROJECT_VALUES = {
  stage: { 'Идея': 'Idea', 'Проверка принципа': 'Proof of concept', 'Прототип': 'Prototype', 'Подготовка пилота': 'Pilot preparation', 'Пилот / первая партия': 'Pilot / first batch', 'Повторное производство': 'Repeat production' },
  productType: { 'Механическое изделие': 'Mechanical product', 'Электронное устройство': 'Electronic device', 'AI / IoT-устройство': 'AI / IoT device', 'Смешанный продукт': 'Mixed product', 'Пока не определено': 'Not decided yet' },
  model: { 'Лицензирование': 'Licensing', 'Пока не определено': 'Not decided yet' },
};
const RISK_VALUES = { 'Радиосвязь': 'Wireless connectivity', 'Батареи': 'Batteries', 'Медицинское назначение': 'Medical use', 'Для детей': 'Use by children', 'Контакт с пищей': 'Food contact', 'Высокие температуры / энергии': 'High temperatures / energy', 'Персональные данные': 'Personal data', 'Пока не знаю': 'Not sure yet' };
const mapped = (map, value) => map && Object.hasOwn(map, value) ? map[value] : value;

// Only controlled enums are migrated. Founder text and historical brief snapshots stay verbatim.
export function migrateWorkspace(value) {
  if (value.version !== 1) return value;
  const project = { ...value.project };
  for (const [key, map] of Object.entries(PROJECT_VALUES)) if (key in project) project[key] = mapped(map, project[key]);
  project.riskFlags = (project.riskFlags || []).map(flag => mapped(RISK_VALUES, flag));
  const records = value.records.map(record => {
    const rules = RECORD_VALUE_MIGRATIONS[record.type];
    const fields = { ...(record.fields || {}) };
    for (const [key, map] of Object.entries(rules?.fields || {})) if (key in fields) fields[key] = mapped(map, fields[key]);
    if (record.type === 'work' && fields.inputs) {
      const inputRules = WORK_VALUE_MIGRATIONS[fields.recipeId] || {};
      fields.inputs = Object.fromEntries(Object.entries(fields.inputs).map(([key, input]) => [key, mapped(inputRules[key], input)]));
    }
    const status = mapped(rules?.status, record.status);
    if (fields.origin === 'onboarding-notes') {
      if (fields.source === 'Ручная вставка при создании проекта') fields.source = 'Pasted during project setup';
      return { ...record, fields, status: record.status === 'Введено фаундером' ? 'New' : status, title: record.title === 'Исходные заметки фаундера' ? 'Initial founder notes' : record.title };
    }
    return { ...record, status, fields };
  });
  return { ...value, version: 2, project, records };
}
