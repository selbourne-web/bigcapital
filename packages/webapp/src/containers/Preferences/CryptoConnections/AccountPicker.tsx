import { FormGroup, HTMLSelect } from '@blueprintjs/core';
import React, { useMemo } from 'react';

export const CREATE_ACCOUNT_VALUE = 'create';

export interface PickableAccount {
  id: number;
  name: string;
  code?: string | null;
  currencyCode?: string | null;
}

/**
 * Narrows the accounts list to asset accounts that are active and not already
 * mapped to another crypto connection. `keepId` keeps the connection's own
 * account selectable.
 */
export const pickAssetAccounts = (
  accounts: Array<Record<string, any>> | undefined,
  mappedIds: ReadonlySet<number>,
  keepId?: number | null,
): PickableAccount[] =>
  (accounts ?? [])
    .filter((account) => {
      const rootType = account.accountRootType ?? account.account_root_type;
      const id = Number(account.id);
      return (
        rootType === 'asset' &&
        account.active !== false &&
        (!mappedIds.has(id) || id === keepId)
      );
    })
    .map((account) => ({
      id: Number(account.id),
      name: String(account.name),
      code: account.code ?? null,
      currencyCode: account.currencyCode ?? account.currency_code ?? null,
    }));

interface AccountPickerProps {
  id: string;
  accounts: PickableAccount[];
  /** `CREATE_ACCOUNT_VALUE` or an account id as a string. */
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  loading?: boolean;
}

/**
 * Chooses the ledger account a connection posts into: an existing, unmapped
 * asset account, or "Create account for me".
 */
export function AccountPicker({
  id,
  accounts,
  value,
  onChange,
  disabled,
  loading,
}: AccountPickerProps) {
  const options = useMemo(
    () => [
      { value: CREATE_ACCOUNT_VALUE, label: 'Create account for me' },
      ...accounts.map((account) => ({
        value: String(account.id),
        label: [
          account.code ? `${account.code} - ` : '',
          account.name,
          account.currencyCode ? ` (${account.currencyCode})` : '',
        ].join(''),
      })),
    ],
    [accounts],
  );

  return (
    <FormGroup
      label="Ledger account"
      labelFor={id}
      helperText={
        loading
          ? 'Loading your asset accounts...'
          : 'Balances and transactions from this connection post to this asset account.'
      }
    >
      <HTMLSelect
        id={id}
        fill
        value={value}
        disabled={disabled}
        options={options}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </FormGroup>
  );
}
