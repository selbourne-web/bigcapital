import {
  Navbar,
  NavbarGroup,
  NavbarDivider,
  Button,
  Classes,
  Tooltip,
  Position,
  MenuItem,
  Menu,
  MenuDivider,
} from '@blueprintjs/core';
import { Popover2 } from '@blueprintjs/popover2';
import * as FF from 'fp-ts/function';
import { useHistory } from 'react-router-dom';
import { DashboardQuickSearchButton } from './_components';
import type { WithDashboardProps } from '@/containers/Dashboard/withDashboard';
import type { WithDialogActionsProps } from '@/containers/Dialog/withDialogActions';
import type { WithUniversalSearchActionsProps } from '@/containers/UniversalSearch/withUniversalSearchActions';
import { FormattedMessage as T, Icon, Hint, If } from '@/components';
import DashboardBackLink from '@/components/Dashboard/DashboardBackLink';
import DashboardBreadcrumbs from '@/components/Dashboard/DashboardBreadcrumbs';
import DashboardTopbarUser from '@/components/Dashboard/TopbarUser';
import { DialogsName } from '@/constants/dialogs';
import {
  COMMUNITY_BIGCAPITAL_LINK,
  DOCS_BIGCAPITAL_LINK,
} from '@/constants/routes';
import { withDashboard } from '@/containers/Dashboard/withDashboard';
import { withDialogActions } from '@/containers/Dialog/withDialogActions';
import { QuickNewDropdown } from '@/containers/QuickNewDropdown/QuickNewDropdown';
import { withUniversalSearchActions } from '@/containers/UniversalSearch/withUniversalSearchActions';

type DashboardTopbarProps = Pick<
  WithDashboardProps,
  'pageTitle' | 'pageHint' | 'editViewId'
> &
  Pick<WithUniversalSearchActionsProps, 'openGlobalSearch'> &
  Pick<WithDialogActionsProps, 'openDialog'>;

/**
 * Dashboard topbar.
 */
function DashboardTopbar({
  // #withDashboard
  pageTitle,
  editViewId,
  pageHint,

  // #withGlobalSearch
  openGlobalSearch,

  // #withDialogActions
  openDialog,
}: DashboardTopbarProps) {
  const history = useHistory();

  const handlerClickEditView = () => {
    history.push(`/custom_views/${editViewId}/edit`);
  };

  return (
    <div className="dashboard__topbar" data-testId={'dashboard-topbar'}>
      <div className="dashboard__topbar-left">
        <div className="dashboard__title">
          <h1>{pageTitle}</h1>

          <If condition={!!pageHint}>
            <div className="dashboard__hint">
              <Hint content={pageHint} />
            </div>
          </If>

          <If condition={!!editViewId}>
            <Button
              className={Classes.MINIMAL + ' button--view-edit'}
              icon={<Icon icon="pen" iconSize={13} />}
              onClick={handlerClickEditView}
            />
          </If>
        </div>

        <div className="dashboard__breadcrumbs">
          <DashboardBreadcrumbs />
        </div>
        <DashboardBackLink />
      </div>

      <div className="dashboard__topbar-right">
        <Navbar className="dashboard__topbar-navbar">
          <NavbarGroup>
            <DashboardQuickSearchButton onClick={() => openGlobalSearch()} />
            <QuickNewDropdown />
            <Tooltip
              content={<T id={'notifications'} />}
              position={Position.BOTTOM}
            >
              <Button
                className={Classes.MINIMAL}
                icon={<Icon icon={'notification-24'} iconSize={20} />}
              />
            </Tooltip>

            <Popover2
              content={
                <Menu>
                  <MenuItem
                    text={'Documents'}
                    onClick={() => window.open(DOCS_BIGCAPITAL_LINK)}
                    labelElement={<Icon icon={'share'} iconSize={16} />}
                  />
                  <MenuItem
                    text={'Community support'}
                    onClick={() => window.open(COMMUNITY_BIGCAPITAL_LINK)}
                    labelElement={<Icon icon={'share'} iconSize={16} />}
                  />
                  <MenuItem
                    text={'Keyboard shortcuts'}
                    onClick={() => openDialog(DialogsName.KeyboardShortcutForm)}
                  />
                  <MenuDivider />
                  <MenuItem text={'Share feedback'} />
                </Menu>
              }
            >
              <Button
                className={Classes.MINIMAL}
                icon={<Icon icon={'help-24'} iconSize={20} />}
                text={<T id={'help'} />}
              />
            </Popover2>
            <NavbarDivider />
          </NavbarGroup>
        </Navbar>

        <div className="dashboard__topbar-user">
          <DashboardTopbarUser />
        </div>
      </div>
    </div>
  );
}

export default FF.pipe(
  DashboardTopbar,
  withDialogActions,
  withDashboard(({ pageTitle, pageHint, editViewId }) => ({
    pageTitle,
    editViewId,
    pageHint,
  })),
  withUniversalSearchActions,
);
