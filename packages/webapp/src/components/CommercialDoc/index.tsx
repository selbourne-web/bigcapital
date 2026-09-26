import styled from 'styled-components';
import { Card } from '../Card';
import { DataTable } from '../Datatable';

// A white page with dark text; the dark theme keeps its dark card.
export const CommercialDocBox = styled(Card)`
  background-color: var(--color-card-background);
  border-radius: 18px;
  color: #000;
  padding: 22px 20px;

  .bp4-dark & {
    color: #f6f7f9;
  }
`;

export const CommercialDocHeader = styled.div`
  margin-bottom: 25px;
`;

export const CommercialDocTopHeader = styled.div`
  margin-bottom: 30px;
`;

export const CommercialDocEntriesTable = styled(DataTable)`
  .tbody .tr:last-child .td {
    border-bottom-width: 1px;
  }
`;

export const CommercialDocFooter = styled.div`
  margin-top: 28px;
`;
