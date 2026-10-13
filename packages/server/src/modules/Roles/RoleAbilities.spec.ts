import { subject } from '@casl/ability';
import { rulesToFields } from '@casl/ability/extra';
import { getAbilityForRole } from './TenantAbilities';
import { AbilitySubject, createAbility } from './Roles.types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const role = (slug: string, permissions: any[] = []) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ({ slug, permissions }) as any;

describe('getAbilityForRole', () => {
  it('lets the predefined admin role manage everything', () => {
    const ability = getAbilityForRole(role('admin'));

    expect(ability.can('View', AbilitySubject.SaleInvoice)).toBe(true);
    expect(ability.can('Delete', AbilitySubject.Role)).toBe(true);
    expect(ability.can('manage', 'all')).toBe(true);
  });

  it('grants only the enabled permissions of a custom role', () => {
    const ability = getAbilityForRole(
      role('accountant', [
        { ability: 'View', subject: AbilitySubject.SaleInvoice, value: true },
        {
          ability: 'Create',
          subject: AbilitySubject.SaleInvoice,
          value: false,
        },
        { ability: 'View', subject: AbilitySubject.Report, value: true },
      ]),
    );

    expect(ability.can('View', AbilitySubject.SaleInvoice)).toBe(true);
    expect(ability.can('View', AbilitySubject.Report)).toBe(true);
    expect(ability.cannot('Create', AbilitySubject.SaleInvoice)).toBe(true);
    expect(ability.cannot('View', AbilitySubject.Bill)).toBe(true);
    expect(ability.cannot('manage', 'all')).toBe(true);
  });

  it('denies everything to a role without permissions', () => {
    const ability = getAbilityForRole(role('empty'));

    expect(ability.can('View', AbilitySubject.Item)).toBe(false);
    expect(ability.rules).toEqual([]);
  });

  it('detects the subject type of tagged objects and class instances', () => {
    const ability = getAbilityForRole(
      role('sales', [
        { ability: 'View', subject: AbilitySubject.SaleInvoice, value: true },
      ]),
    );
    class SaleInvoice {}
    class Bill {}

    expect(
      ability.can('View', subject(AbilitySubject.SaleInvoice, { id: 1 })),
    ).toBe(true);
    expect(ability.can('View', subject(AbilitySubject.Bill, { id: 1 }))).toBe(
      false,
    );
    expect(ability.can('View', new SaleInvoice())).toBe(true);
    expect(ability.can('View', new Bill())).toBe(false);
  });
});

describe('createAbility (conditions)', () => {
  it('matches mongo-style conditions against the subject', () => {
    const ability = createAbility([
      { action: 'read', subject: 'Article', conditions: { authorId: 1 } },
      {
        action: 'update',
        subject: 'Article',
        conditions: { status: { $in: ['draft', 'review'] } },
      },
    ]);

    expect(ability.can('read', subject('Article', { authorId: 1 }))).toBe(true);
    expect(ability.can('read', subject('Article', { authorId: 2 }))).toBe(
      false,
    );
    // A subject type check ignores conditions.
    expect(ability.can('read', 'Article')).toBe(true);
    expect(ability.can('update', subject('Article', { status: 'draft' }))).toBe(
      true,
    );
    expect(
      ability.can('update', subject('Article', { status: 'published' })),
    ).toBe(false);
  });

  it('applies inverted rules after broader grants', () => {
    const ability = createAbility([
      { action: 'manage', subject: 'all' },
      {
        action: 'delete',
        subject: 'Article',
        inverted: true,
        conditions: { published: true },
      },
    ]);

    expect(
      ability.cannot('delete', subject('Article', { published: true })),
    ).toBe(true);
    expect(
      ability.can('delete', subject('Article', { published: false })),
    ).toBe(true);
    expect(ability.can('create', 'Article')).toBe(true);
  });
});

// GHSA-x9vf-53q3-cvx6 (@casl/ability <= 6.7.4): rulesToFields() copied
// condition keys such as "__proto__.x" onto the result, polluting
// Object.prototype.
describe('rulesToFields prototype pollution', () => {
  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (Object.prototype as any).caslPolluted;
  });

  it('does not write insecure condition keys onto Object.prototype', () => {
    const ability = createAbility([
      {
        action: 'read',
        subject: 'Article',
        conditions: { '__proto__.caslPolluted': 'yes', authorId: 1 },
      },
    ]);

    const fields = rulesToFields(ability, 'read', 'Article');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(({} as any).caslPolluted).toBeUndefined();
    expect(fields).toMatchObject({ authorId: 1 });
  });
});
