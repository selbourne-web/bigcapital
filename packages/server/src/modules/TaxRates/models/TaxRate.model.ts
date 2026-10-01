import { TenantBaseModel } from '@/modules/System/models/TenantBaseModel';
import { ExportableModel } from '@/modules/Export/decorators/ExportableModel.decorator';
import { ImportableModel } from '@/modules/Import/decorators/Import.decorator';
import { InjectModelMeta } from '@/modules/Tenancy/TenancyModels/decorators/InjectModelMeta.decorator';
import { TaxRateMeta } from './TaxRate.meta';

/** Resource name the import/export screens use ("tax-rate" / "tax_rate"). */
export const TAX_RATE_RESOURCE = 'TaxRate';

@ExportableModel()
@ImportableModel()
@InjectModelMeta(TaxRateMeta)
export class TaxRateModel extends TenantBaseModel {
  active!: boolean;
  code!: string;
  name!: string;
  rate!: number;
  description?: string;

  /**
   * Table name
   */
  static get tableName() {
    return 'tax_rates';
  }

  /**
   * Soft delete query builder.
   */
  // static get QueryBuilder() {
  // return SoftDeleteQueryBuilder;
  // }

  /**
   * Timestamps columns.
   */
  get timestamps() {
    return ['createdAt', 'updatedAt'];
  }

  /**
   * Virtual attributes.
   */
  static get virtualAttributes() {
    return [];
  }

  /**
   * Model modifiers.
   */
  static get modifiers() {
    return {};
  }

  /**
   * Relationship mapping.
   */
  static get relationMappings() {
    return {};
  }
}
