export const STAGES = ['Idea', 'Proof of concept', 'Prototype', 'Pilot preparation', 'Pilot / first batch', 'Repeat production'];
export const TYPES = ['Mechanical product', 'Electronic device', 'AI / IoT device', 'Mixed product', 'Not decided yet'];

// [label, placeholder, control type, options] for each project brief field.
export const FIELDS = {
  name: ['Project name', 'For example, a personal air-quality sensor'],
  description: ['What are you building?', 'What does the product do, and what problem does it solve?', 'textarea'],
  audience: ['Who is it for?', 'Who uses it, who buys it, and in what situation?', 'textarea'],
  model: ['Business model', '', 'select', ['B2B', 'B2C', 'B2B + B2C', 'Licensing', 'Not decided yet']],
  markets: ['Target countries', 'For example: Germany, United States. Leave blank if unknown.'],
  productType: ['Product type', '', 'select', TYPES],
  stage: ['Current stage', '', 'select', STAGES],
  team: ['Team and capabilities', 'What can you do yourself? Who is already involved?', 'textarea'],
  budget: ['Available budget', 'Leave blank if unknown', 'number'],
  currency: ['Currency', '', 'select', ['USD', 'EUR', 'RUB', 'CNY', 'GBP']],
  constraints: ['Constraints', 'Timing, materials, dimensions and available resources', 'textarea'],
  goal: ['Next milestone', 'What specific outcome do you want next?', 'textarea'],
  notes: ['Existing context', 'Paste your notes or a discussion summary.', 'textarea'],
};
