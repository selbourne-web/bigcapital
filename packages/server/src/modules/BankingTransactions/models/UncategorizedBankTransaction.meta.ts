export const UncategorizedBankTransactionMeta = {
  defaultFilterField: 'createdAt',
  defaultSort: {
    sortOrder: 'DESC',
    sortField: 'created_at',
  },
  importable: true,
  fields: {
    date: {
      name: 'Date',
      column: 'date',
      fieldType: 'date',
    },
    payee: {
      name: 'Payee',
      column: 'payee',
      fieldType: 'text',
    },
    description: {
      name: 'Description',
      column: 'description',
      fieldType: 'text',
    },
    referenceNo: {
      name: 'Reference No.',
      column: 'reference_no',
      fieldType: 'text',
    },
    amount: {
      name: 'Amount',
      column: 'Amount',
      fieldType: 'numeric',
      required: true,
    },
    runningBalance: {
      name: 'Running Balance',
      column: 'running_balance',
      fieldType: 'numeric',
    },
    account: {
      name: 'Account',
      column: 'account_id',
      fieldType: 'relation',
      to: { model: 'Account', to: 'id' },
    },
    createdAt: {
      name: 'Created At',
      column: 'createdAt',
      fieldType: 'date',
      importable: false,
    },
  },
  fields2: {
    date: {
      name: 'Date',
      fieldType: 'date',
      required: true,
    },
    payee: {
      name: 'Payee',
      fieldType: 'text',
      importHint:
        "Optional - most bank statements don't have a separate payee column. Leave this unmapped (the Description already carries that text); you can assign a customer or vendor to the transaction later when categorizing it.",
    },
    description: {
      name: 'Description',
      fieldType: 'text',
    },
    referenceNo: {
      name: 'Reference No.',
      fieldType: 'text',
    },
    amount: {
      name: 'Amount',
      fieldType: 'number',
      required: true,
      altGroup: 'amount',
      importHint:
        'A single signed amount (negative for withdrawals/debits, positive for deposits/credits). Switch to "Two columns" above if your statement uses separate Debit Amount / Credit Amount columns instead.',
    },
    debitAmount: {
      name: 'Debit Amount',
      fieldType: 'number',
      altGroup: 'amount',
      altLabel: 'Money spent',
      importHint:
        'Money leaving the account (withdrawal). Either sign works - a plain positive magnitude or an already-negative value, both are read correctly.',
    },
    creditAmount: {
      name: 'Credit Amount',
      fieldType: 'number',
      altGroup: 'amount',
      altLabel: 'Money received',
      importHint: 'Money coming into the account (deposit).',
    },
    runningBalance: {
      name: 'Running Balance',
      fieldType: 'number',
      importHint:
        'The account balance your bank reported after this transaction. Optional - used only to help you verify the import matches your bank statement.',
    },
  },
};
