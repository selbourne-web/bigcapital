// @ts-nocheck
import { Classes, FormGroup, Intent, Position } from '@blueprintjs/core';
import { DateInput } from '@blueprintjs/datetime';
import classNames from 'classnames';
import moment from 'moment';
import React, { useCallback, useMemo } from 'react';
import { CellType } from '@/constants';
import { useDateInputFormatter } from '@/hooks';

const DAY_FORMAT = 'YYYY-MM-DD';

/**
 * Date cell of an editable table. The value is kept as a `YYYY-MM-DD` day (or
 * empty), the same shape the forms use for their other dates.
 */
export default function DateInputCell({
  row: { index },
  column: { id, dateInputProps },
  cell: { value: initialValue },
  payload: { updateData, errors },
}) {
  const dateFormatter = useDateInputFormatter();

  // Only the first ten characters matter: a stored day may arrive as an ISO
  // string, which must not be moved by the browser's time zone.
  const value = useMemo(() => {
    const day = initialValue ? String(initialValue).slice(0, 10) : '';
    const parsed = moment(day, DAY_FORMAT, true);
    return parsed.isValid() ? parsed.toDate() : null;
  }, [initialValue]);

  const handleChange = useCallback(
    (date: Date | null, isUserChange: boolean) => {
      if (!isUserChange) return;
      updateData(index, id, date ? moment(date).format(DAY_FORMAT) : null);
    },
    [updateData, index, id],
  );
  const error = errors?.[index]?.[id];

  return (
    <FormGroup
      intent={error ? Intent.DANGER : null}
      className={classNames(Classes.FILL, 'form-group--date-cell')}
    >
      <DateInput
        {...dateFormatter}
        value={value}
        onChange={handleChange}
        popoverProps={{
          position: Position.BOTTOM_LEFT,
          minimal: true,
          boundary: 'window',
        }}
        inputProps={{ fill: true }}
        canClearSelection={true}
        {...dateInputProps}
      />
    </FormGroup>
  );
}

DateInputCell.cellType = CellType.Field;
