import React from 'react';
import clsx from 'classnames';
import { get, isFunction } from 'lodash';
import { x } from '@xstyled/emotion';
import { css } from '@emotion/css';
import { Box, BoxProps } from '../lib/layout/Box';
import { Group, GroupProps } from '../lib/layout/Group';
import { Stack } from '../lib/layout/Stack';

// Palette of the document layout (modelled on the reference QuickBooks PDFs).
const MUTED = '#6b7378';
const TITLE = '#55606a';
const BAND = '#e6e9eb';

export interface PaperTemplateProps extends BoxProps {
  primaryColor?: string;
  secondaryColor?: string;
  children?: React.ReactNode;
}

export function PaperTemplate({
  primaryColor,
  secondaryColor,
  children,
  ...restProps
}: PaperTemplateProps) {
  return (
    <Box
      backgroundColor="#fff"
      color="#111"
      boxShadow="inset 0 4px 0px 0 var(--invoice-primary-color)"
      padding="40px 40px"
      fontSize="12px"
      position="relative"
      m="0 auto"
      minHeight="1123px"
      w="794px"
      boxSizing="border-box"
      display="flex"
      flexDirection="column"
      {...restProps}
      className={clsx(
        restProps?.className,
        css`
          @media print {
            width: auto !important;
          }
        `
      )}
    >
      <style>{`:root { --invoice-primary-color: ${primaryColor}; --invoice-secondary-color: ${secondaryColor}; }`}</style>
      {children}
    </Box>
  );
}

interface PaperTemplateBigTitleProps {
  title: string;
}

PaperTemplate.BigTitle = ({ title }: PaperTemplateBigTitleProps) => {
  return (
    <x.h1
      fontSize={'28px'}
      margin={0}
      lineHeight={1.1}
      fontWeight={400}
      color={TITLE}
    >
      {title}
    </x.h1>
  );
};

interface PaperTemplateLogoProps {
  logoUri: string;
}

PaperTemplate.Logo = ({ logoUri }: PaperTemplateLogoProps) => {
  return (
    <x.div overflow={'hidden'}>
      <x.img
        width={'100%'}
        height={'100%'}
        maxWidth={'190px'}
        maxHeight={'110px'}
        alt=""
        src={logoUri}
      />
    </x.div>
  );
};

interface PaperTemplateTableProps {
  columns: Array<{
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    accessor: string | ((data: Record<string, any>) => JSX.Element);
    label: string;
    value?: JSX.Element;
    align?: 'left' | 'center' | 'right';
    thStyle?: React.CSSProperties;
    visible?: boolean;
  }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Array<Record<string, any>>;
}

PaperTemplate.Table = ({ columns, data }: PaperTemplateTableProps) => {
  const filteredColumns = columns.filter((col) => col.visible !== false);

  return (
    <table
      className={css`
        width: 100%;
        border-collapse: collapse;
        text-align: left;

        thead th {
          font-weight: 400;
          background: ${BAND};
          color: ${MUTED};
          padding: 8px 10px;
        }
        tbody {
          td {
            border-bottom: 1px solid #f1f2f3;
            padding: 12px 10px;
            vertical-align: top;
          }
        }
      `}
    >
      <thead>
        <tr>
          {filteredColumns.map((col, index) => (
            <x.th key={index} textAlign={col.align} style={col.thStyle}>
              {col.label}
            </x.th>
          ))}
        </tr>
      </thead>

      <tbody>
        {data.map((_data, rowIndex) => (
          <tr key={rowIndex}>
            {filteredColumns.map((column, index) => (
              <x.td textAlign={column.align} key={index}>
                {isFunction(column?.accessor)
                  ? column?.accessor(_data)
                  : get(_data, column.accessor)}
              </x.td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
};

// eslint-disable-next-line react-refresh/only-export-components
export enum PaperTemplateTotalBorder {
  Gray = 'gray',
  Dark = 'dark',
}

PaperTemplate.Totals = ({ children }: { children: React.ReactNode }) => {
  return (
    <x.div
      style={{
        display: 'flex',
        flexDirection: 'column',
        marginLeft: 'auto',
        width: '320px',
      }}
    >
      {children}
    </x.div>
  );
};

const totalBottomBordered = css`
  border-bottom: 1px solid #000;
`;
const totalBottomGrayBordered = css`
  border-bottom: 1px solid #dadada;
`;

PaperTemplate.TotalLine = ({
  label,
  amount,
  border,
  style,
  emphasis,
}: {
  label: string;
  amount: string;
  border?: PaperTemplateTotalBorder;
  /** Large bold figure, for the amount that matters (total / balance due). */
  emphasis?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  style?: any;
}) => {
  return (
    <x.div
      display={'flex'}
      alignItems={'baseline'}
      padding={emphasis ? '8px 0' : '5px 0'}
      className={clsx({
        [totalBottomBordered]: border === PaperTemplateTotalBorder.Dark,
        [totalBottomGrayBordered]: border === PaperTemplateTotalBorder.Gray,
      })}
      style={style}
    >
      <x.div min-w="160px" color={MUTED} textTransform={'uppercase'}>
        {label}
      </x.div>
      <x.div
        flex={'1 1 auto'}
        textAlign={'right'}
        fontSize={emphasis ? '20px' : undefined}
        fontWeight={emphasis ? 700 : undefined}
      >
        {amount}
      </x.div>
    </x.div>
  );
};

PaperTemplate.AddressesGroup = (props: GroupProps) => {
  return (
    <Group
      spacing={10}
      align={'flex-start'}
      {...props}
      className={css`
        > div {
          flex: 1;
        }
      `}
    />
  );
};

PaperTemplate.Address = ({ children }: { children: React.ReactNode }) => {
  return <Box>{children}</Box>;
};

PaperTemplate.Statement = ({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) => {
  return (
    <x.div mb={'14px'}>
      {label && <x.div color={MUTED}>{label}</x.div>}
      <x.div>{children}</x.div>
    </x.div>
  );
};

PaperTemplate.TermsList = ({ children }: { children: React.ReactNode }) => {
  return (
    <x.div display={'flex'} flexDirection={'column'} gap={'4px'}>
      {children}
    </x.div>
  );
};

PaperTemplate.TermsItem = ({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) => {
  return (
    <Group spacing={12} noWrap>
      <x.div minWidth={'120px'} color={MUTED} textTransform={'uppercase'}>
        {label}
      </x.div>
      <x.div>{children}</x.div>
    </Group>
  );
};

// ---------------------------------------------------------------------------
// Document layout pieces
// ---------------------------------------------------------------------------

interface PaperTemplateDocumentHeadProps {
  title: string;

  showLogo?: boolean;
  logoUri?: string;

  companyName?: string;
  showCompanyAddress?: boolean;
  /** Html: address lines, phone, email, website... */
  companyAddress?: string;

  showCustomerAddress?: boolean;
  customerAddressLabel?: string;
  /** Html. */
  customerAddress?: string;

  /** Document number, dates, terms... shown at the right. */
  children?: React.ReactNode;
}

/**
 * The top of every document: logo and company block, the document title, then
 * the customer address at the left and the document details at the right.
 */
PaperTemplate.DocumentHead = ({
  title,
  showLogo = true,
  logoUri,
  companyName,
  showCompanyAddress = true,
  companyAddress,
  showCustomerAddress = true,
  customerAddressLabel,
  customerAddress,
  children,
}: PaperTemplateDocumentHeadProps) => {
  const hasLogo = !!logoUri && showLogo;

  return (
    <Stack spacing={26}>
      <Group align={'flex-start'} spacing={30} noWrap>
        {hasLogo && (
          <Box flex={'0 0 190px'}>
            <PaperTemplate.Logo logoUri={logoUri} />
          </Box>
        )}
        <Stack spacing={2} flex={1}>
          {companyName && (
            <x.div fontSize={'15px'} fontWeight={700}>
              {companyName}
            </x.div>
          )}
          {showCompanyAddress && companyAddress && (
            <Box
              lineHeight={1.55}
              dangerouslySetInnerHTML={{ __html: companyAddress }}
            />
          )}
        </Stack>
      </Group>

      <PaperTemplate.BigTitle title={title} />

      <Group align={'flex-start'} position={'apart'} spacing={20} noWrap>
        <Box flex={1}>
          {showCustomerAddress && (
            <>
              {customerAddressLabel && (
                <x.div
                  color={MUTED}
                  textTransform={'uppercase'}
                  marginBottom={'4px'}
                >
                  {customerAddressLabel}
                </x.div>
              )}
              <Box
                lineHeight={1.55}
                dangerouslySetInnerHTML={{ __html: customerAddress || '' }}
              />
            </>
          )}
        </Box>
        <Box flex={'0 0 320px'}>
          <PaperTemplate.TermsList>{children}</PaperTemplate.TermsList>
        </Box>
      </Group>
    </Stack>
  );
};

/** A dashed rule that separates the line items from the summary. */
PaperTemplate.Divider = () => (
  <x.div
    borderBottom={'1px dashed #c4c9cd'}
    margin={'8px 0 12px'}
    h={'1px'}
  />
);

/** Notes at the left, the totals block at the right. */
PaperTemplate.Summary = ({
  notes,
  children,
}: {
  notes?: React.ReactNode;
  children: React.ReactNode;
}) => {
  return (
    <Group align={'flex-start'} spacing={30} noWrap>
      <Box flex={1} color={MUTED} lineHeight={1.55}>
        {notes}
      </Box>
      <Box flex={'0 0 320px'}>{children}</Box>
    </Group>
  );
};

/** Green "PAID" mark shown under the balance of a settled invoice. */
PaperTemplate.PaidStamp = ({ label = 'PAID' }: { label?: string }) => (
  <x.div
    textAlign={'right'}
    color={'#1a8f3c'}
    fontWeight={700}
    fontSize={'22px'}
    letterSpacing={'0.04em'}
    padding={'4px 0'}
  >
    {label}
  </x.div>
);

/** Tax rate, tax amount and the net amount it applies to. */
PaperTemplate.TaxSummary = ({
  label = 'Tax summary',
  taxes,
  rateLabel = 'Rate',
  taxLabel = 'Tax',
  netLabel = 'Net',
}: {
  label?: string;
  taxes: Array<{ label: string; amount: string; net?: string }>;
  rateLabel?: string;
  taxLabel?: string;
  netLabel?: string;
}) => {
  if (!taxes?.length) return null;

  return (
    <Stack spacing={6}>
      <x.div fontWeight={700} textTransform={'uppercase'}>
        {label}
      </x.div>
      <PaperTemplate.Table
        columns={[
          { label: rateLabel, accessor: 'label', align: 'center' },
          { label: taxLabel, accessor: 'amount', align: 'center' },
          { label: netLabel, accessor: 'net', align: 'right' },
        ]}
        data={taxes}
      />
    </Stack>
  );
};

/** Blank lines to sign or date by hand, each with its label underneath. */
PaperTemplate.Signatures = ({ labels }: { labels: string[] }) => (
  <Group align={'flex-end'} spacing={60} noWrap marginTop={'20px'}>
    {labels.map((label) => (
      <Box key={label} flex={1}>
        <x.div h={'36px'} borderBottom={'1px solid #9aa1a6'} />
        <x.div color={MUTED} marginTop={'4px'}>
          {label}
        </x.div>
      </Box>
    ))}
  </Group>
);

/** Small centred text at the bottom of the page (or after the content when it runs long). */
PaperTemplate.Footer = ({ children }: { children?: React.ReactNode }) => {
  if (!children) return null;

  return (
    <x.div
      marginTop={'auto'}
      paddingTop={'30px'}
      textAlign={'center'}
      color={MUTED}
      fontSize={'11px'}
      lineHeight={1.6}
      whiteSpace={'pre-line'}
    >
      {children}
    </x.div>
  );
};
