/**
 * Import/export metadata for tax rates, restored from the pre-NestJS
 * `TaxRate.settings` (upstream commit 72678bb93), with the field types it had
 * wrong ('name'/'code') corrected to 'text' and `isCompound` added.
 */
export const TaxRateMeta = {
  defaultSort: {
    sortOrder: 'DESC',
    sortField: 'created_at',
  },
  exportable: true,
  importable: true,
  print: {
    pageTitle: 'Tax Rates',
  },
  fields: {
    name: { name: 'Tax Name', column: 'name', fieldType: 'text' },
    code: { name: 'Code', column: 'code', fieldType: 'text' },
    rate: { name: 'Rate', column: 'rate', fieldType: 'number' },
    description: {
      name: 'Description',
      column: 'description',
      fieldType: 'text',
    },
    active: { name: 'Active', column: 'active', fieldType: 'boolean' },
  },
  columns: {
    name: { name: 'Tax Name', type: 'text', accessor: 'name' },
    code: { name: 'Code', type: 'text', accessor: 'code' },
    rate: { name: 'Rate', type: 'number' },
    description: { name: 'Description', type: 'text' },
    isNonRecoverable: { name: 'Is Non Recoverable', type: 'boolean' },
    isCompound: { name: 'Is Compound', type: 'boolean' },
    active: { name: 'Active', type: 'boolean' },
  },
  fields2: {
    name: { name: 'Tax Name', fieldType: 'text', required: true },
    code: { name: 'Code', fieldType: 'text', required: true },
    rate: { name: 'Rate', fieldType: 'number', required: true },
    description: { name: 'Description', fieldType: 'text' },
    isNonRecoverable: { name: 'Is Non Recoverable', fieldType: 'boolean' },
    isCompound: { name: 'Is Compound', fieldType: 'boolean' },
    active: { name: 'Active', fieldType: 'boolean' },
  },
};
