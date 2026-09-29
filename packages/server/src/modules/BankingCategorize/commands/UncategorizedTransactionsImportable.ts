import { Inject, Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import * as yup from 'yup';
import * as uniqid from 'uniqid';
import { isNumber } from 'lodash';
import { Importable } from '../../Import/Importable';
import { CreateUncategorizedTransactionService } from './CreateUncategorizedTransaction.service';
import { ImportableContext } from '../../Import/interfaces';
import { BankTransactionsSampleData } from '../../BankingTransactions/constants';
import { Account } from '@/modules/Accounts/models/Account.model';
import { CreateUncategorizedTransactionDTO } from '../types/BankingCategorize.types';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { ImportableService } from '../../Import/decorators/Import.decorator';
import { UncategorizedBankTransaction } from '../../BankingTransactions/models/UncategorizedBankTransaction';

/**
 * The raw shape of a mapped import row before `transform()` resolves it to
 * a real `CreateUncategorizedTransactionDTO`. `amount` may be absent when the
 * sheet was mapped with split debit/credit columns instead.
 */
type ImportRowDTO = Omit<CreateUncategorizedTransactionDTO, 'amount'> & {
  amount?: number;
  debitAmount?: number;
  creditAmount?: number;
};
@Injectable()
@ImportableService({ name: UncategorizedBankTransaction.name })
export class UncategorizedTransactionsImportable extends Importable {
  constructor(
    private readonly createUncategorizedTransaction: CreateUncategorizedTransactionService,

    @Inject(Account.name)
    private readonly accountModel: TenantModelProxy<typeof Account>,
  ) {
    super();
  }

  /**
   * Passing the sheet DTO to create uncategorized transaction.
   * @param {CreateUncategorizedTransactionDTO,} createDTO
   * @param {Knex.Transaction} trx
   */
  public async importable(
    createDTO: CreateUncategorizedTransactionDTO,
    trx?: Knex.Transaction,
  ) {
    return this.createUncategorizedTransaction.create(createDTO, trx);
  }

  /**
   * Transformes the DTO before validating and importing.
   *
   * Resolves `amount` from either a direct signed "Amount" mapping or a
   * split "Debit Amount" / "Credit Amount" mapping (the shape most real bank
   * statement exports use), and strips the transient debit/credit fields -
   * they aren't real columns, only `amount` is stored.
   * @param {ImportRowDTO} createDTO
   * @param {ImportableContext} context
   * @returns {CreateUncategorizedTransactionDTO}
   */
  public transform(
    createDTO: ImportRowDTO,
    context?: ImportableContext,
  ): CreateUncategorizedTransactionDTO {
    const { amount, debitAmount, creditAmount, ...rest } = createDTO;
    // Some exports (e.g. CIBC) already store the debit column as a negative
    // number; others store it as a positive magnitude. Math.abs() normalizes
    // either convention before combining, so the result is always negative
    // for a debit-only row and positive for a credit-only row.
    const resolvedAmount = isNumber(amount)
      ? amount
      : isNumber(debitAmount) || isNumber(creditAmount)
        ? Math.abs(creditAmount || 0) - Math.abs(debitAmount || 0)
        : undefined;

    return {
      ...rest,
      amount: resolvedAmount,
      accountId: context.import.paramsParsed.accountId,
      batch: context.import.paramsParsed.batch,
    } as CreateUncategorizedTransactionDTO;
  }

  /**
   * Sample data used to download sample sheet.
   * @returns {Record<string, any>[]}
   */
  public sampleData(): Record<string, any>[] {
    return BankTransactionsSampleData;
  }

  // ------------------
  // # Params
  // ------------------
  /**
   * Params validation schema.
   * @returns {ValidationSchema[]}
   */
  public paramsValidationSchema() {
    return yup.object().shape({
      accountId: yup.number().required(),
    });
  }

  /**
   * Validates the params existance asyncly.
   * @param {number} tenantId -
   * @param {Record<string, any>} params -
   */
  public async validateParams(params: Record<string, any>): Promise<void> {
    if (params.accountId) {
      await this.accountModel()
        .query()
        .findById(params.accountId)
        .throwIfNotFound({});
    }
  }

  /**
   * Transforms the import params before storing them.
   * @param {Record<string, any>} parmas
   */
  public transformParams(parmas: Record<string, any>) {
    const batch = uniqid();

    return {
      ...parmas,
      batch,
    };
  }
}
