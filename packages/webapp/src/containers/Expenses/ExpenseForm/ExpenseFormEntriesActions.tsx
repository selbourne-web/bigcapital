import React from 'react';
import styled from 'styled-components';
import { FFormGroup, FSelect } from '@/components';
import { InclusiveTaxOptions } from '@/constants/InclusiveTaxOptions';
import { EntriesActionsBar } from '@/containers/Entries/EntriesActionBar';

/**
 * "Amounts are Exclusive/Inclusive of Tax" above the expense lines. Switching
 * keeps the amounts as typed and only changes how the tax is worked out.
 */
export function ExpenseFormEntriesActions() {
  return (
    <EntriesActionsBar>
      <InclusiveFormGroup
        name={'inclusiveExclusiveTax'}
        label={'Amounts are'}
        inline={true}
      >
        <FSelect
          name={'inclusiveExclusiveTax'}
          items={InclusiveTaxOptions}
          textAccessor={'label'}
          labelAccessor={() => ''}
          valueAccessor={'key'}
          popoverProps={{ minimal: true, usePortal: true, inline: false }}
          buttonProps={{ small: true }}
          filterable={false}
        />
      </InclusiveFormGroup>
    </EntriesActionsBar>
  );
}

const InclusiveFormGroup = styled(FFormGroup)`
  margin-left: auto;
`;
