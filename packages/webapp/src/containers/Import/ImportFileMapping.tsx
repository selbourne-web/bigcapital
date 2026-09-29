import { Button, HTMLSelect, Intent, Position } from '@blueprintjs/core';
import clsx from 'classnames';
import { useFormikContext } from 'formik';
import { get } from 'lodash';
import { useCallback, useMemo, useState } from 'react';
import { ImportStepperStep } from './_types';
import { getFieldKey } from './_utils';
import { ImportFileContainer } from './ImportFileContainer';
import styles from './ImportFileMapping.module.scss';
import { ImportFileMapBootProvider } from './ImportFileMappingBoot';
import { ImportFileMappingForm } from './ImportFileMappingForm';
import { EntityColumnField, useImportFileContext } from './ImportFileProvider';
import type { ImportFileMappingFormValues } from './_types';
import type { ChangeEvent } from 'react';
import { Box, FSelect, Group, Hint } from '@/components';
import { CLASSES } from '@/constants';

export function ImportFileMapping() {
  const { importId, entityColumns } = useImportFileContext();

  return (
    <ImportFileMapBootProvider importId={importId}>
      <ImportFileMappingForm>
        <ImportFileContainer>
          <p>
            Review and map the column headers in your csv/xlsx file with the
            Selbourne Financial fields.
          </p>

          {entityColumns.map((entityColumn) => (
            <ImportFileMappingGroup
              key={entityColumn.groupKey || entityColumn.groupLabel}
              groupKey={entityColumn.groupKey}
              groupLabel={entityColumn.groupLabel}
              fields={entityColumn.fields}
            />
          ))}
        </ImportFileContainer>
        <ImportFileMappingFloatingActions />
      </ImportFileMappingForm>
    </ImportFileMapBootProvider>
  );
}

interface ImportFileMappingGroupProps {
  groupKey: string;
  groupLabel: string;
  fields: EntityColumnField[];
}

function ImportFileMappingGroup({
  groupKey,
  groupLabel,
  fields,
}: ImportFileMappingGroupProps) {
  return (
    <Box className={styles.group}>
      {groupLabel && <h3 className={styles.groupTitle}>{groupLabel}</h3>}

      <table className={clsx('bp4-html-table', styles.table)}>
        <thead>
          <tr>
            <th className={styles.label}>Selbourne Financial Fields</th>
            <th className={styles.field}>Sheet Column Headers</th>
          </tr>
        </thead>
        <tbody>
          <ImportFileMappingFields fields={fields} />
        </tbody>
      </table>
    </Box>
  );
}

interface ImportFileMappingFieldsProps {
  fields: EntityColumnField[];
}

type SheetItem = { value: string; text: string };

interface AltFieldGroup {
  altGroup: string;
  /** The field with no `altLabel` - the toggle's "one column" option. */
  single?: EntityColumnField;
  /** Fields with an `altLabel` - the toggle's "split columns" options. */
  splits: EntityColumnField[];
}

type MappingRow =
  | { kind: 'field'; field: EntityColumnField }
  | { kind: 'altGroup'; group: AltFieldGroup };

/**
 * Fields sharing an `altGroup` collapse into one row (see `AltFieldGroup`),
 * inserted at the position of that group's first member so the table order
 * still matches the field metadata order.
 */
function buildMappingRows(fields: EntityColumnField[]): MappingRow[] {
  const rows: MappingRow[] = [];
  const groups = new Map<string, AltFieldGroup>();

  fields.forEach((field) => {
    if (!field.altGroup) {
      rows.push({ kind: 'field', field });
      return;
    }
    let group = groups.get(field.altGroup);
    if (!group) {
      group = { altGroup: field.altGroup, splits: [] };
      groups.set(field.altGroup, group);
      rows.push({ kind: 'altGroup', group });
    }
    if (field.altLabel) {
      group.splits.push(field);
    } else {
      group.single = field;
    }
  });
  return rows;
}

function ImportFileMappingFields({ fields }: ImportFileMappingFieldsProps) {
  const { sheetColumns } = useImportFileContext();

  const items = useMemo(
    () => sheetColumns.map((column) => ({ value: column, text: column })),
    [sheetColumns],
  );
  const rows = useMemo(() => buildMappingRows(fields), [fields]);

  return (
    <>
      {rows.map((row, index) =>
        row.kind === 'field' ? (
          <ImportFileMappingFieldRow
            key={row.field.key ?? index}
            column={row.field}
            items={items}
          />
        ) : (
          <ImportFileMappingAltGroupRows
            key={row.group.altGroup}
            group={row.group}
            items={items}
          />
        ),
      )}
    </>
  );
}

interface ImportFileMappingFieldRowProps {
  column: EntityColumnField;
  items: SheetItem[];
  /** Sub-row under an alt-group's shared label, using `altLabel`. */
  indented?: boolean;
}

function ImportFileMappingFieldRow({
  column,
  items,
  indented = false,
}: ImportFileMappingFieldRowProps) {
  return (
    <tr>
      <td className={clsx(styles.label, indented && styles.labelIndented)}>
        {indented ? (column.altLabel ?? column.name) : column.name}{' '}
        {column.required && <span className={styles.requiredSign}>*</span>}
      </td>
      <td className={styles.field}>
        <Group spacing={4}>
          <FSelect
            name={getFieldKey(column.key, column.group)}
            items={items}
            popoverProps={{ minimal: true }}
            minimal={true}
            fill={true}
          />
          {column.hint && (
            <Hint content={column.hint} position={Position.BOTTOM} />
          )}
        </Group>
      </td>
    </tr>
  );
}

const alGroupColumnsLabel = (count: number) =>
  count === 2 ? 'Two columns' : `${count} columns`;

interface ImportFileMappingAltGroupRowsProps {
  group: AltFieldGroup;
  items: SheetItem[];
}

/**
 * One shared label (e.g. "Amount") with a mode toggle that switches between
 * a single mapping row and the group's alternate split rows (e.g. "Debit
 * Amount" / "Credit Amount"), matching how most bank-CSV importers let a
 * statement's amount be either one signed column or two.
 */
function ImportFileMappingAltGroupRows({
  group,
  items,
}: ImportFileMappingAltGroupRowsProps) {
  const { single, splits, altGroup } = group;
  const { values, setFieldValue } =
    useFormikContext<ImportFileMappingFormValues>();

  const singleKey = single ? getFieldKey(single.key, single.group) : null;
  const splitKeys = useMemo(
    () => splits.map((field) => getFieldKey(field.key, field.group)),
    [splits],
  );
  const hasSplitValue = splitKeys.some((key) => !!get(values, key));

  // Only read the initial mapping once; afterwards the toggle owns the mode.
  const [mode, setMode] = useState<'single' | 'split'>(() =>
    hasSplitValue ? 'split' : 'single',
  );

  const handleModeChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const nextMode = event.currentTarget.value as 'single' | 'split';
      setMode(nextMode);

      // Clear the values of the fields we're about to hide, so a stale
      // mapping is never silently submitted for a field the user can't see.
      const keysToClear =
        nextMode === 'single' ? splitKeys : singleKey ? [singleKey] : [];
      keysToClear.forEach((key) => setFieldValue(key, ''));
    },
    [singleKey, splitKeys, setFieldValue],
  );

  if (!single && splits.length === 0) return null;

  return (
    <>
      <tr>
        <td className={styles.label}>{single?.name ?? altGroup}</td>
        <td className={styles.field}>
          <HTMLSelect
            minimal
            fill
            value={mode}
            onChange={handleModeChange}
            options={[
              { value: 'single', label: 'One column' },
              { value: 'split', label: alGroupColumnsLabel(splits.length) },
            ]}
          />
        </td>
      </tr>
      {mode === 'single' && single && (
        <ImportFileMappingFieldRow column={single} items={items} />
      )}
      {mode === 'split' &&
        splits.map((field) => (
          <ImportFileMappingFieldRow
            key={field.key}
            column={field}
            items={items}
            indented
          />
        ))}
    </>
  );
}

function ImportFileMappingFloatingActions() {
  const { isSubmitting } = useFormikContext<ImportFileMappingFormValues>();
  const { setStep } = useImportFileContext();

  const handleCancelBtnClick = () => {
    setStep(ImportStepperStep.Upload);
  };

  return (
    <div className={clsx(CLASSES.PAGE_FORM_FLOATING_ACTIONS)}>
      <Group spacing={10}>
        <Button onClick={handleCancelBtnClick}>Back</Button>
        <Button type="submit" intent={Intent.PRIMARY} loading={isSubmitting}>
          Next
        </Button>
      </Group>
    </div>
  );
}
