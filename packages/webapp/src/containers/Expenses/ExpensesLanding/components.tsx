import {
  Intent,
  Button,
  Classes,
  Popover,
  Tooltip,
  Position,
  Tag,
  MenuItem,
  Menu,
  MenuDivider,
} from '@blueprintjs/core';
import clsx from 'classnames';
import React, { ReactNode } from 'react';
import intl from 'react-intl-universal';
import type { DataTableColumn } from '@/components/Datatable/types';
import type { Expense } from '@bigcapital/sdk-ts';
import { FormattedMessage as T, Icon, If, Can } from '@/components';
import { ExpenseAction, AbilitySubject } from '@/constants/abilityOption';
import { CLASSES } from '@/constants/classes';
import { safeCallback } from '@/utils';

interface ExpenseAccount {
  id: number;
  name: string;
  code?: string;
}

interface PaymentAccount {
  id: number;
  name: string;
  code?: string;
}

export type ExpenseCategoryTableRow = {
  id: number;
  amount: number;
  allocatedCostAmount: number;
  expenseAccountId: number;
  description: string;
  unallocatedCostAmount: number;
  expenseAccount?: ExpenseAccount;
};

export type ExpenseTableRow = Omit<Expense, 'categories'> & {
  categories: ExpenseCategoryTableRow[];
  formattedDate?: string;
  formattedAmount?: string;
  paymentAccount?: PaymentAccount;
  payeeName?: string | null;
  formattedSalesTaxAmount?: string;
  formattedAmountBeforeSalesTax?: string;
};

interface ActionsMenuPayload {
  onPublish: (expense: ExpenseTableRow) => void;
  onEdit: (expense: ExpenseTableRow) => void;
  onDelete: (expense: ExpenseTableRow) => void;
  onViewDetails: (expense: ExpenseTableRow) => void;
}

interface ActionsMenuProps {
  row: { original: ExpenseTableRow };
  payload: ActionsMenuPayload;
}

/**
 * Description accessor.
 */
export function DescriptionAccessor(row: ExpenseTableRow): ReactNode {
  return (
    <If condition={!!row.description}>
      <Tooltip
        className={Classes.TOOLTIP_INDICATOR}
        content={row.description}
        position={Position.TOP}
        hoverOpenDelay={250}
      >
        <Icon icon={'file-alt'} iconSize={16} />
      </Tooltip>
    </If>
  );
}

/**
 * Actions menu.
 */
export function ActionsMenu({
  row: { original },
  payload: { onPublish, onEdit, onDelete, onViewDetails },
}: ActionsMenuProps) {
  return (
    <Menu>
      <MenuItem
        icon={<Icon icon="reader-18" />}
        text={intl.get('view_details')}
        onClick={safeCallback(onViewDetails, original)}
      />
      <Can I={ExpenseAction.Edit} a={AbilitySubject.Expense}>
        <MenuDivider />
        <If condition={!original.isPublished}>
          <MenuItem
            icon={
              // Icon wants `iconSize`, not `size`; preserved from @ts-nocheck.
              // @ts-expect-error see comment above
              <Icon icon={'arrow-to-top'} size={16} />
            }
            text={intl.get('publish_expense')}
            onClick={safeCallback(onPublish, original)}
          />
        </If>
      </Can>
      <Can I={ExpenseAction.Edit} a={AbilitySubject.Expense}>
        <MenuItem
          icon={<Icon icon="pen-18" />}
          text={intl.get('edit_expense')}
          onClick={safeCallback(onEdit, original)}
        />
      </Can>
      <Can I={ExpenseAction.Delete} a={AbilitySubject.Expense}>
        <MenuDivider />
        <MenuItem
          icon={<Icon icon="trash-16" iconSize={16} />}
          text={intl.get('delete_expense')}
          intent={Intent.DANGER}
          onClick={safeCallback(onDelete, original)}
        />
      </Can>
    </Menu>
  );
}

/**
 * Actions cell.
 */
export function ActionsCell(props: ActionsMenuProps) {
  return (
    <Popover
      content={<ActionsMenu {...props} />}
      position={Position.RIGHT_BOTTOM}
    >
      <Button icon={<Icon icon="more-h-16" iconSize={16} />} />
    </Popover>
  );
}

/**
 * Publish accessor.
 */
export function PublishAccessor(row: ExpenseTableRow): ReactNode {
  return row.isPublished ? (
    <Tag intent={Intent.SUCCESS} round minimal>
      <T id={'published'} />
    </Tag>
  ) : (
    <Tag round minimal intent={Intent.WARNING}>
      <T id={'draft'} />
    </Tag>
  );
}

/**
 * Expense account accessor.
 */
export function ExpenseAccountAccessor(expense: ExpenseTableRow): ReactNode {
  if (expense.categories.length === 1) {
    return expense.categories[0].expenseAccount?.name;
  } else if (expense.categories.length > 1) {
    return <T id={'expense.column.multi_categories'} />;
  }
  return null;
}

/**
 * Reference number cell: the number, with a tag while the expense is a draft.
 */
export function ReferenceAccessor(expense: ExpenseTableRow): ReactNode {
  return (
    <>
      {expense.referenceNo}
      {!expense.isPublished && (
        <Tag round minimal intent={Intent.WARNING} className="ml1">
          <T id={'draft'} />
        </Tag>
      )}
    </>
  );
}

/**
 * Category cell: the account of a single-category expense, or "--Split--".
 */
export function CategoryAccessor(expense: ExpenseTableRow): ReactNode {
  if (expense.categories.length === 1) {
    return expense.categories[0].expenseAccount?.name;
  }
  return expense.categories.length > 1 ? '--Split--' : null;
}

/**
 * Retrieve the expenses table columns: date, reference no., payee, category,
 * the total before sales tax, the sales tax and the total (as in QuickBooks).
 */
export function useExpensesTableColumns(): DataTableColumn<ExpenseTableRow>[] {
  return React.useMemo(
    () =>
      [
        {
          id: 'payment_date',
          Header: 'Date',
          accessor: 'formattedDate',
          width: 120,
          className: 'payment_date',
          clickable: true,
        },
        {
          id: 'reference_no',
          Header: 'Reference No.',
          accessor: (row: ExpenseTableRow) => ReferenceAccessor(row),
          width: 150,
          clickable: true,
        },
        {
          id: 'payee',
          Header: 'Payee',
          accessor: 'payeeName',
          width: 200,
          disableSortBy: true,
          clickable: true,
        },
        {
          id: 'category',
          Header: 'Category',
          accessor: (row: ExpenseTableRow) => CategoryAccessor(row),
          width: 220,
          disableSortBy: true,
          clickable: true,
        },
        {
          id: 'amount_before_sales_tax',
          Header: 'Total before Sales Tax/VAT',
          accessor: 'formattedAmountBeforeSalesTax',
          align: 'right',
          width: 190,
          disableSortBy: true,
          clickable: true,
          money: true,
        },
        {
          id: 'sales_tax',
          Header: 'Sales Tax',
          accessor: 'formattedSalesTaxAmount',
          align: 'right',
          width: 120,
          disableSortBy: true,
          clickable: true,
          money: true,
        },
        {
          id: 'amount',
          Header: 'Total',
          accessor: 'formattedAmount',
          align: 'right',
          width: 130,
          clickable: true,
          money: true,
          className: clsx(CLASSES.FONT_BOLD),
        },
      ] as DataTableColumn<ExpenseTableRow>[],
    [],
  );
}
