import moment from 'moment';
import { DashboardRangeSelect } from './DashboardRangeSelect';
import { QuickActions } from './QuickActions';
import { ShortcutsColumn } from './ShortcutsColumn';
import {
  AgingWidget,
  CashFlowWidget,
  ExpensesWidget,
  IncomeExpensesWidget,
  ProfitLossWidget,
} from './Widgets';
import { useDashboardData, useSampleMode } from './useDashboardData';
import { useDashboardRange } from './useDashboardRange';
import { useAuthenticatedAccount } from '@/hooks/query';
import '@/style/pages/HomePage/Dashboard.scss';

const greetingFor = (hour: number): string =>
  hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

/**
 * The financial summary at the top of the homepage: a date range picker,
 * quick actions, and charts drawn from the organization's reports.
 */
export function DashboardHome() {
  const { selection, range, granularity, setSelection } = useDashboardRange();
  const sample = useSampleMode();
  const { profitLoss, cashFlow, receivables, payables } = useDashboardData({
    range,
    granularity,
    sample,
  });
  const { data: user } = useAuthenticatedAccount();

  const greeting = greetingFor(moment().hour());

  return (
    <div className="dash">
      <div className="dash__header">
        <h2 className="dash__greeting">
          {greeting}
          {user?.firstName ? `, ${user.firstName}` : ''}
        </h2>
        <DashboardRangeSelect
          selection={selection}
          range={range}
          onChange={setSelection}
        />
      </div>

      <QuickActions />

      {sample && (
        <p className="dash__sample" role="status">
          {sample === 'empty'
            ? 'Sample preview of the empty state. Nothing here is from your books.'
            : 'Sample data preview. These figures are not from your books.'}
        </p>
      )}

      <div className="dash__layout">
        <div className="dash__grid">
          <ProfitLossWidget query={profitLoss} range={range} />
          <IncomeExpensesWidget query={profitLoss} range={range} />
          <CashFlowWidget query={cashFlow} range={range} />
          <ExpensesWidget query={profitLoss} range={range} />
          <AgingWidget query={receivables} kind="receivable" range={range} />
          <AgingWidget query={payables} kind="payable" range={range} />
        </div>

        <ShortcutsColumn />
      </div>
    </div>
  );
}
