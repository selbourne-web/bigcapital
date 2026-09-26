/**
 * Browser entry: only the React components, without the server-side renderers
 * (which pull in Node-only modules). The webapp aliases `@bigcapital/pdf-templates`
 * to this file so its live previews render exactly what the server prints and
 * attaches to email.
 */
export * from './components/PaperTemplate';
export * from './components/InvoicePaperTemplate';
export * from './components/CreditNotePaperTemplate';
export * from './components/EstimatePaperTemplate';
export * from './components/ReceiptPaperTemplate';
export * from './components/PaymentReceivedPaperTemplate';
