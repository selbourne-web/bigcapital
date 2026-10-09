import { Injectable } from '@nestjs/common';
import { CsvImportView } from '../csv/csvImport.types';
import { CryptoConnectionRepository } from '../commands/CryptoConnection.repository';
import { CryptoCsvImportRepository } from '../commands/CryptoCsvImport.repository';
import {
  connectionNotFound,
  toCsvImportView,
} from '../commands/CryptoCsvImportView';

export const CRYPTO_CSV_IMPORTS_LIMIT = 200;

@Injectable()
export class GetCryptoCsvImportsService {
  constructor(
    private readonly connections: CryptoConnectionRepository,
    private readonly imports: CryptoCsvImportRepository,
  ) {}

  /** Import history of a connection, newest first. */
  async execute(connectionId: number): Promise<CsvImportView[]> {
    if (!(await this.connections.findById(connectionId))) {
      throw connectionNotFound();
    }
    const rows = await this.imports.listImports(
      connectionId,
      CRYPTO_CSV_IMPORTS_LIMIT,
    );
    return rows.map(toCsvImportView);
  }
}
