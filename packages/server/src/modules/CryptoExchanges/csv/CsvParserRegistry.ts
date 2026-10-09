import { CryptoExchangeId } from '../CryptoExchanges.constants';
import { CsvImportError, CsvParser } from './csv.types';

const MAX_HEADERS_IN_MESSAGE = 20;

export class CsvParserRegistry {
  constructor(private readonly parsers: CsvParser[]) {}

  resolve(exchange: CryptoExchangeId, headers: string[]): CsvParser {
    const match = this.parsers.find(
      (p) => p.exchange === exchange && p.matches(headers),
    );
    if (!match) {
      const shown = headers.slice(0, MAX_HEADERS_IN_MESSAGE).join(', ');
      const more =
        headers.length > MAX_HEADERS_IN_MESSAGE
          ? ` (+${headers.length - MAX_HEADERS_IN_MESSAGE} more)`
          : '';
      throw new CsvImportError(
        'CSV_FORMAT_UNRECOGNIZED',
        `Unrecognized CSV format for ${exchange}. Headers found: ${shown}${more}`,
      );
    }
    if (match.disposition === 'refuse') {
      throw new CsvImportError(
        'CSV_DERIVED_EXPORT_REFUSED',
        match.refuseReason ?? 'This derived export cannot be imported',
        { parserId: match.id },
      );
    }
    return match;
  }
}
