// @ts-nocheck
import { FormGroup, Classes, Intent } from '@blueprintjs/core';
import classNames from 'classnames';
import React, { useCallback, useRef } from 'react';
import intl from 'react-intl-universal';
import { ItemsSuggest } from '@/components';
import { CellType } from '@/constants';
import { useCellAutoFocus, useOpenDropdownOnRealClick } from '@/hooks';

/**
 * Items list cell.
 */
export default function ItemsListCell({
  column: { id, filterSellable, filterPurchasable, fieldProps, formGroupProps },
  row: { index },
  cell: { value: initialValue },
  payload: { items, updateData, errors, autoFocus },
}) {
  const fieldRef = useRef();

  // Auto-focus the items list input field.
  useCellAutoFocus(fieldRef, autoFocus, id, index);

  // Dropdown style: opens on click, but not from the row-0 auto-focus above,
  // which would otherwise pop the list open on page load.
  const dropdownOpen = useOpenDropdownOnRealClick();

  // Handle the item selected.
  const handleItemSelected = useCallback(
    (item) => {
      updateData(index, id, item.id);
      // The list reopens on the next click, which needs the field to lose focus.
      fieldRef.current?.blur();
    },
    [updateData, index, id],
  );

  const error = errors?.[index]?.[id];

  return (
    <FormGroup
      intent={error ? Intent.DANGER : null}
      className={classNames(
        'form-group--select-list',
        'form-group--dropdown',
        Classes.FILL,
      )}
      {...formGroupProps}
    >
      <ItemsSuggest
        items={items}
        onItemSelect={handleItemSelected}
        selectedValue={initialValue}
        sellable={filterSellable}
        purchasable={filterPurchasable}
        inputProps={{
          inputRef: (ref) => (fieldRef.current = ref),
          placeholder: intl.get('enter_an_item'),
          ...dropdownOpen.inputProps,
        }}
        // Dropdown style: the list opens on click and can still be searched
        // by typing.
        openOnKeyDown={dropdownOpen.openOnKeyDown}
        {...fieldProps}
      />
    </FormGroup>
  );
}

ItemsListCell.cellType = CellType.Field;
