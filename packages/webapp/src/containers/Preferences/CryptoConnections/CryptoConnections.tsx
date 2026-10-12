import { Alert, Button, Callout, Intent, Spinner } from '@blueprintjs/core';
import * as FF from 'fp-ts/function';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { flattenAccounts, pickAssetAccounts } from './AccountPicker';
import {
  AddConnectionDialog,
  describeCryptoError,
} from './AddConnectionDialog';
import { AddCsvOnlyConnectionDialog } from './AddCsvOnlyConnectionDialog';
import { ConnectionRow } from './ConnectionRow';
import styles from './CryptoConnections.module.scss';
import type { WithDashboardActionsProps } from '@/containers/Dashboard/withDashboardActions';
import { AppToaster, Card } from '@/components';
import {
  CryptoExchangeAction,
  AbilitySubject,
} from '@/constants/abilityOption';
import { CLASSES } from '@/constants/classes';
import { withDashboardActions } from '@/containers/Dashboard/withDashboardActions';
import { useAccounts } from '@/hooks/query';
import {
  useCryptoConnections,
  useDeleteCryptoConnection,
  type CryptoConnection,
} from '@/hooks/query/crypto';
import { useAbilityContext } from '@/hooks/utils';

type CryptoConnectionsProps = Pick<
  WithDashboardActionsProps,
  'changePreferencesPageTitle'
>;

/**
 * Crypto exchange connections: link read-only exchange API keys, see their
 * status and sync them. Values are never shown here, only connection state.
 */
function CryptoConnectionsPreferences({
  // #withDashboardActions
  changePreferencesPageTitle,
}: CryptoConnectionsProps) {
  useEffect(() => {
    changePreferencesPageTitle('Crypto connections');
  }, [changePreferencesPageTitle]);

  const ability = useAbilityContext();
  const canView = ability.can(
    CryptoExchangeAction.View,
    AbilitySubject.CryptoExchange,
  );
  const canCreate = ability.can(
    CryptoExchangeAction.Create,
    AbilitySubject.CryptoExchange,
  );
  const canEdit = ability.can(
    CryptoExchangeAction.Edit,
    AbilitySubject.CryptoExchange,
  );
  const canDelete = ability.can(
    CryptoExchangeAction.Delete,
    AbilitySubject.CryptoExchange,
  );

  const connectionsQuery = useCryptoConnections({ enabled: canView });
  const accountsQuery = useAccounts({}, { enabled: canView });
  const deleteMutation = useDeleteCryptoConnection();

  const [addOpen, setAddOpen] = useState(false);
  const [addCsvOpen, setAddCsvOpen] = useState(false);
  const [rotateTarget, setRotateTarget] = useState<CryptoConnection | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] = useState<CryptoConnection | null>(
    null,
  );

  const connections = connectionsQuery.data;
  // GET /accounts may return a tree (children nested): flatten it.
  const accounts = useMemo(
    () =>
      accountsQuery.data
        ? flattenAccounts(accountsQuery.data as Array<Record<string, any>>)
        : undefined,
    [accountsQuery.data],
  );

  const accountsById = useMemo(() => {
    const map = new Map<number, Record<string, any>>();
    (accounts ?? []).forEach((account) => map.set(Number(account.id), account));
    return map;
  }, [accounts]);

  // A connection can point at an account created after the list was loaded.
  // Refetch once per distinct set of missing ids before calling it unmapped.
  const missingKey = useMemo(
    () =>
      accounts
        ? (connections ?? [])
            .filter(
              (c) => c.accountId != null && !accountsById.has(c.accountId),
            )
            .map((c) => c.accountId)
            .sort()
            .join(',')
        : '',
    [accounts, connections, accountsById],
  );
  const refetchedFor = useRef<string>('');
  const refetchAccounts = accountsQuery.refetch;
  useEffect(() => {
    if (missingKey && refetchedFor.current !== missingKey) {
      refetchedFor.current = missingKey;
      refetchAccounts();
    }
  }, [missingKey, refetchAccounts]);

  const mappedIds = useMemo(
    () =>
      new Set(
        (connections ?? [])
          .map((c) => c.accountId)
          .filter((id): id is number => id != null),
      ),
    [connections],
  );

  const pickable = useMemo(
    () => pickAssetAccounts(accounts, mappedIds),
    [accounts, mappedIds],
  );

  const handleConfirmDelete = () => {
    if (!deleteTarget) return;
    deleteMutation.mutate(
      { id: deleteTarget.id },
      {
        onSuccess: () => {
          AppToaster.show({
            message: `${deleteTarget.label} was removed.`,
            intent: Intent.SUCCESS,
          });
          setDeleteTarget(null);
        },
        onError: (error) => {
          AppToaster.show({
            message: describeCryptoError(error),
            intent: Intent.DANGER,
          });
          setDeleteTarget(null);
        },
      },
    );
  };

  if (!canView) {
    return (
      <div className={CLASSES.PREFERENCES_PAGE_INSIDE_CONTENT}>
        <Card className={styles.card}>
          <h4>Crypto connections</h4>
          <p className={styles.note}>
            You do not have permission to view crypto connections.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className={CLASSES.PREFERENCES_PAGE_INSIDE_CONTENT}>
      <Card className={styles.card}>
        <div className={styles.head}>
          <div>
            <h4>Crypto connections</h4>
            <p className={styles.note}>
              Connect a read-only API key from your exchange. Selbourne
              Financial reads balances and history and never trades or
              withdraws.
            </p>
          </div>
          {canCreate && (
            <div className={styles.headActions}>
              <Button
                intent={Intent.PRIMARY}
                icon="plus"
                onClick={() => setAddOpen(true)}
              >
                Add connection
              </Button>
              <Button icon="document" onClick={() => setAddCsvOpen(true)}>
                Add CSV-only connection
              </Button>
            </div>
          )}
        </div>

        {connectionsQuery.isLoading && (
          <div className={styles.loading} role="status" aria-label="Loading">
            <Spinner size={24} />
          </div>
        )}

        {connectionsQuery.isError && (
          <Callout intent={Intent.DANGER} role="alert">
            {describeCryptoError(connectionsQuery.error)}{' '}
            <Button small minimal onClick={() => connectionsQuery.refetch()}>
              Retry
            </Button>
          </Callout>
        )}

        {connections && connections.length === 0 && (
          <p className={styles.empty}>
            No exchanges connected yet.
            {canCreate
              ? ' Use "Add connection" to link one, or "Add CSV-only connection" for an exchange you import reports from.'
              : ''}
          </p>
        )}

        {connections && connections.length > 0 && (
          <ul className={styles.list}>
            {connections.map((connection) => {
              const account =
                connection.accountId != null
                  ? accountsById.get(connection.accountId)
                  : undefined;
              // Only call it unmapped once accounts have loaded, so the badge
              // does not flash while the list is still arriving.
              const accountsReady = !!accounts;
              return (
                <ConnectionRow
                  key={connection.id}
                  connection={connection}
                  accountName={account ? String(account.name) : null}
                  accountMissing={
                    accountsReady &&
                    (connection.accountId == null ||
                      (!account && !accountsQuery.isFetching))
                  }
                  canEdit={canEdit}
                  canDelete={canDelete}
                  canImport={canCreate}
                  onRotate={setRotateTarget}
                  onDelete={setDeleteTarget}
                />
              );
            })}
          </ul>
        )}
      </Card>

      <AddConnectionDialog
        isOpen={addOpen}
        onClose={() => setAddOpen(false)}
        accounts={pickable}
        accountsLoading={accountsQuery.isLoading}
      />
      <AddCsvOnlyConnectionDialog
        isOpen={addCsvOpen}
        onClose={() => setAddCsvOpen(false)}
        accounts={pickable}
        accountsLoading={accountsQuery.isLoading}
      />
      <AddConnectionDialog
        isOpen={!!rotateTarget}
        onClose={() => setRotateTarget(null)}
        accounts={[]}
        rotate={rotateTarget}
      />

      <Alert
        isOpen={!!deleteTarget}
        intent={Intent.DANGER}
        icon="trash"
        cancelButtonText="Cancel"
        confirmButtonText="Delete connection"
        loading={deleteMutation.isPending}
        canEscapeKeyCancel
        onCancel={() => setDeleteTarget(null)}
        onConfirm={handleConfirmDelete}
      >
        <p>
          Delete <strong>{deleteTarget?.label}</strong>? Its stored API key is
          erased and syncing stops. Transactions already imported are kept.
        </p>
      </Alert>
    </div>
  );
}

export const CryptoConnections = FF.pipe(
  CryptoConnectionsPreferences,
  withDashboardActions,
);
