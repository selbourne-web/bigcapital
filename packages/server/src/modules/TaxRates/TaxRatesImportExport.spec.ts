import { ResourceService } from '../Resource/ResourceService';
import { sanitizeResourceName } from '../Import/_utils';
import { getImportableService } from '../Import/decorators/Import.decorator';
import { getExportableService } from '../Export/decorators/ExportableModel.decorator';
import { TAX_RATE_RESOURCE, TaxRateModel } from './models/TaxRate.model';
import { TaxRatesImportable } from './TaxRatesImportable';
import { TaxRatesExportable } from './TaxRatesExportable';
import { TaxRatesSampleData } from './TaxRatesImportable.SampleData';

// The model is injected as a factory returning the class, like the tenancy proxy.
const resourceServiceWith = (registered: Record<string, unknown>) =>
  new ResourceService(
    {} as any,
    {} as any,
    {
      get: (name: string) => {
        if (!(name in registered)) throw new Error(`Nest can't find ${name}`);
        return registered[name];
      },
    } as any,
    {} as any,
  );

describe('Tax rates import/export wiring', () => {
  it.each(['tax-rate', 'tax_rate', 'tax-rates'])(
    'resource name "%s" resolves to the registered name',
    (resource) => {
      expect(sanitizeResourceName(resource)).toBe(TAX_RATE_RESOURCE);
    },
  );

  it('registers the importer and exporter under that name', () => {
    expect(getImportableService(TAX_RATE_RESOURCE)).toBe(TaxRatesImportable);
    expect(getExportableService(TAX_RATE_RESOURCE)).toBe(TaxRatesExportable);
  });

  it('finds the model even though its class is named TaxRateModel', () => {
    const service = resourceServiceWith({
      TaxRateModel: () => TaxRateModel,
    });
    expect(service.getResourceModel('tax-rate')()).toBe(TaxRateModel);
  });

  it('still reports an unknown resource', () => {
    const service = resourceServiceWith({});
    expect(() => service.getResourceModel('nope')).toThrow();
  });

  it('gives the model import/export metadata', () => {
    const service = resourceServiceWith({
      TaxRateModel: () => TaxRateModel,
    });
    const meta = service.getResourceMeta('tax_rate');
    expect(meta.importable).toBe(true);
    expect(meta.exportable).toBe(true);
    expect(Object.keys(meta.fields2)).toEqual(
      expect.arrayContaining(['name', 'code', 'rate', 'isCompound', 'active']),
    );
    // Upstream had invalid field types here; every import field needs a real one.
    Object.values(meta.fields2).forEach((field: any) =>
      expect(['text', 'number', 'boolean']).toContain(field.fieldType),
    );
    expect(Object.keys(meta.columns)).toEqual(
      expect.arrayContaining(['name', 'code', 'rate', 'active']),
    );
  });

  it('matches every sample and exported column to an import field', () => {
    const meta = TaxRateModel.getMeta();
    const importLabels = Object.values(meta.fields2).map((f: any) =>
      f.name.toLowerCase(),
    );
    // The import screen pairs sheet headers with fields by name (any case).
    Object.keys(TaxRatesSampleData[0]).forEach((header) =>
      expect(importLabels).toContain(header.toLowerCase()),
    );
    Object.values(meta.columns).forEach((column: any) =>
      expect(importLabels).toContain(column.name.toLowerCase()),
    );
  });
});
