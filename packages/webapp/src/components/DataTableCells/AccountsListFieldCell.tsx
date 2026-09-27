// @ts-nocheck
import { FormGroup, Classes, Intent } from '@blueprintjs/core';
import classNames from 'classnames';
import React, { useRef, useCallback, useMemo } from 'react';
import intl from 'react-intl-universal';
import { AccountsSuggestField } from '@/components';
import { CellType } from '@/constants';
import { useCellAutoFocus } from '@/hooks';

/**
 * Account cell renderer.
 */
export default function AccountCellRenderer({
  column: {
    id,
    accountsDataProp,
    filterAccountsByRootTypes,
    filterAccountsByTypes,
    dropdown,
    fieldProps,
    formGroupProps,
  },
  row: { index, original },
  cell: { value: initialValue },
  payload: {
    accounts: defaultAccounts,
    updateData,
    errors,
    autoFocus,
    ...restPayloadProps
  },
}) {
  const accountRef = useRef();

  useCellAutoFocus(accountRef, autoFocus, id, index);

  const handleAccountSelected = useCallback(
    (account) => {
      updateData(index, id, account.id);
      // A dropdown reopens on the next click, which needs it to lose focus.
      if (dropdown) accountRef.current?.blur();
    },
    [updateData, index, id, dropdown],
  );
  const error = errors?.[index]?.[id];

  const accounts = useMemo(
    () => restPayloadProps[accountsDataProp] || defaultAccounts,
    [restPayloadProps, defaultAccounts, accountsDataProp],
  );

  return (
    <FormGroup
      intent={error ? Intent.DANGER : null}
      className={classNames(
        'form-group--select-list',
        'form-group--account',
        { 'form-group--dropdown': dropdown },
        Classes.FILL,
      )}
      {...formGroupProps}
    >
      <AccountsSuggestField
        items={accounts}
        onItemSelect={handleAccountSelected}
        selectedValue={initialValue}
        filterByRootTypes={filterAccountsByRootTypes}
        filterByTypes={filterAccountsByTypes}
        inputProps={{
          inputRef: (ref) => (accountRef.current = ref),
          placeholder: intl.get('search'),
        }}
        // Dropdown style: the list opens on click, not only on a key press.
        openOnKeyDown={!dropdown}
        {...fieldProps}
      />
    </FormGroup>
  );
}
AccountCellRenderer.cellType = CellType.Field;
