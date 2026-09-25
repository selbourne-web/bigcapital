import React from 'react';
import { AccountsPayableSection } from './AccountsPayableSection';
import { AccountsReceivableSection } from './AccountsReceivableSection';
import { DashboardHome } from './dashboard';
import { FinancialAccountingSection } from './FinancialAccountingSection';
import { ProductsServicesSection } from './ProductsServicesSection';
import '@/style/pages/HomePage/HomePage.scss';

export function HomepageContent() {
  return (
    <>
      <DashboardHome />

      <div className="financial-reports">
        <h2 className="financial-reports__heading">Shortcuts</h2>
        <AccountsReceivableSection />
        <AccountsPayableSection />
        <FinancialAccountingSection />
        <ProductsServicesSection />
      </div>
    </>
  );
}
