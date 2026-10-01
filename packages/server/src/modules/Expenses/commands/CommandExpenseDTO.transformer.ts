import { Inject, Injectable } from '@nestjs/common';
import { keyBy, omit, sumBy, uniq } from 'lodash';
import * as moment from 'moment';
import * as R from 'ramda';
import * as composeAsync from 'async/compose';
import { BranchTransactionDTOTransformer } from '@/modules/Branches/integrations/BranchTransactionDTOTransform';
import { Expense } from '../models/Expense.model';
import { assocItemEntriesDefaultIndex } from '@/utils/associate-item-entries-index';
import { TenancyContext } from '@/modules/Tenancy/TenancyContext.service';
import { CreateExpenseDto, EditExpenseDto } from '../dtos/Expense.dto';
import { TaxRateModel } from '@/modules/TaxRates/models/TaxRate.model';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { computeExpenseTax } from '@bigcapital/utils';

@Injectable()
export class ExpenseDTOTransformer {
  /**
   * @param {BranchTransactionDTOTransformer} branchDTOTransform - Branch transaction DTO transformer.
   * @param {TenancyContext} tenancyContext - Tenancy context.
   */
  constructor(
    private readonly branchDTOTransform: BranchTransactionDTOTransformer,
    private readonly tenancyContext: TenancyContext,

    @Inject(TaxRateModel.name)
    private readonly taxRateModel: TenantModelProxy<typeof TaxRateModel>,
  ) {}

  /**
   * Mapping expense DTO to model.
   * @param {IExpenseDTO} expenseDTO
   * @param {ISystemUser} authorizedUser
   * @return {IExpense}
   */
  private async expenseDTOToModel(
    expenseDTO: CreateExpenseDto | EditExpenseDto,
  ): Promise<Expense> {
    const isInclusiveTax = !!expenseDTO.isInclusiveTax;

    // Snapshot each line's tax rate (%) as it is today, like bills do; a
    // line keeps its rate even if the tax rate is edited later.
    const dtoLines = expenseDTO.categories || [];
    const taxRateIds = uniq(
      dtoLines.map((line) => line.taxRateId).filter(Boolean),
    );
    const taxRates = taxRateIds.length
      ? await this.taxRateModel().query().whereIn('id', taxRateIds)
      : [];
    const taxRatesById = keyBy(taxRates, 'id');

    const withTaxRates = dtoLines.map((line) => ({
      ...line,
      taxRateId: line.taxRateId || null,
      taxRate: line.taxRateId
        ? (taxRatesById[line.taxRateId]?.rate ?? null)
        : null,
    }));
    const tax = computeExpenseTax(withTaxRates, isInclusiveTax);

    // Landed cost is allocated on what the goods cost, tax excluded.
    const landedCostAmount = sumBy(
      withTaxRates.map((line, index) => ({
        ...line,
        netAmount: tax.lines[index].netAmount,
      })),
      (line) => (line.landedCost === true ? line.netAmount : 0),
    );
    const totalAmount = tax.total;

    const categories = R.compose(
      // Associate the default index to categories lines.
      assocItemEntriesDefaultIndex,
    )(withTaxRates);

    const initialDTO = {
      ...omit(expenseDTO, ['publish', 'attachments']),
      isInclusiveTax,
      categories,
      totalAmount,
      landedCostAmount,
      paymentDate: moment(expenseDTO.paymentDate).toMySqlDateTime(),
      ...(expenseDTO.publish
        ? {
            publishedAt: moment().toMySqlDateTime(),
          }
        : {}),
    };
    const asyncDto = await composeAsync(
      this.branchDTOTransform.transformDTO<Expense>,
    )(initialDTO);

    return asyncDto as Expense;
  }

  /**
   * Transforms the expense create DTO.
   * @param {IExpenseCreateDTO} expenseDTO
   * @returns {Promise<Expense>}
   */
  public expenseCreateDTO = async (
    expenseDTO: CreateExpenseDto | EditExpenseDto,
  ): Promise<Partial<Expense>> => {
    const initialDTO = await this.expenseDTOToModel(expenseDTO);
    const tenant = await this.tenancyContext.getTenant(true);

    return {
      ...initialDTO,
      currencyCode: expenseDTO.currencyCode || tenant?.metadata?.baseCurrency,
      exchangeRate: expenseDTO.exchangeRate || 1,
      // ...(user
      //   ? {
      //       userId: user.id,
      //     }
      //   : {}),
    };
  };

  /**
   * Transformes the expense edit DTO.
   * @param {EditExpenseDto} expenseDTO
   * @returns {Promise<Expense>}
   */
  public expenseEditDTO = async (
    expenseDTO: EditExpenseDto,
  ): Promise<Expense> => {
    return this.expenseDTOToModel(expenseDTO);
  };
}
