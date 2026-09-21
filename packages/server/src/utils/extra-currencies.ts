// js-money does not ship the Barbados dollar, so register it on its currency
// map. Import this module before any `js-money/lib/currency` import.
const currencies = require('js-money/lib/currency');

if (!currencies.BBD) {
  currencies.BBD = {
    symbol: 'Bds$',
    name: 'Barbadian Dollar',
    symbol_native: '$',
    decimal_digits: 2,
    rounding: 0,
    code: 'BBD',
    name_plural: 'Barbadian dollars',
  };
}
