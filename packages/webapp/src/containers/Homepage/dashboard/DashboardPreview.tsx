/**
 * Dev-only design preview of the dashboard, reachable without signing in at
 * `/__preview/dashboard?sample=1`. It seeds the query cache with a fictional
 * organization and user (so no request is made and nothing can trigger a
 * sign-out) and relies on sample report data. Registered in `App.tsx` under
 * `import.meta.env.DEV`, so it is not part of production builds.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { DashboardHome } from './DashboardHome';
import { organizationKeys } from '@/hooks/query/organization';
import { usersKeys } from '@/hooks/query/users/query-keys';

export default function DashboardPreview() {
  const queryClient = useQueryClient();

  // Seed once, before the first render of the dashboard.
  useState(() => {
    const organization = organizationKeys.current();
    const account = usersKeys.authenticatedAccount();
    queryClient.setQueryDefaults(organization, { staleTime: Infinity });
    queryClient.setQueryDefaults(account, { staleTime: Infinity });
    queryClient.setQueryData(organization, {
      metadata: {
        name: 'Selbourne',
        baseCurrency: 'BBD',
        fiscalYear: 'january',
      },
    });
    queryClient.setQueryData(account, {
      firstName: 'Scott',
      lastName: 'Griffith',
      verified: true,
      email: 'preview@example.com',
    });
    return null;
  });

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--color-dashboard-insider-background)',
      }}
    >
      <DashboardHome />
    </div>
  );
}
