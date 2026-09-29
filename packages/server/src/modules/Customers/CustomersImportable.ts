import { Knex } from 'knex';
import { CustomersSampleData } from './_SampleData';
import { Injectable } from '@nestjs/common';
import { Importable } from '../Import/Importable';
import { ImportableContext } from '../Import/interfaces';
import { ImportableService } from '../Import/decorators/Import.decorator';
import { CreateCustomer } from './commands/CreateCustomer.service';
import { CreateCustomerDto } from './dtos/CreateCustomer.dto';
import { Customer } from './models/Customer';

@Injectable()
@ImportableService({ name: Customer.name })
export class CustomersImportable extends Importable {
  constructor(private readonly createCustomerService: CreateCustomer) {
    super();
  }

  /**
   * Mapps the imported data to create a new customer service.
   * @param {number} tenantId
   * @param {ICustomerNewDTO} createDTO
   * @param {Knex.Transaction} trx
   * @returns {Promise<void>}
   */
  public async importable(
    createDTO: CreateCustomerDto,
    trx?: Knex.Transaction<any, any[]>,
  ): Promise<void> {
    await this.createCustomerService.createCustomer(createDTO, trx);
  }

  /**
   * Defaults `customerType` to "business" when the sheet has no equivalent
   * column (e.g. a QuickBooks Online export) - matches the New Customer
   * form's own default, and avoids the required-field check rejecting
   * every row of an otherwise-clean import over a distinction the source
   * file has no way to express.
   * @param {Record<string, any>} createDTO
   * @param {ImportableContext} context
   * @returns {CreateCustomerDto}
   */
  public transform(
    createDTO: Record<string, any>,
    _context?: ImportableContext,
  ): CreateCustomerDto {
    return {
      customerType: 'business',
      ...createDTO,
    } as CreateCustomerDto;
  }

  /**
   * Retrieves the sample data of customers used to download sample sheet.
   */
  public sampleData(): any[] {
    return CustomersSampleData;
  }
}
