import * as bcrypt from 'bcrypt';
import { BaseModel } from '@/models/Model';

export class SystemUser extends BaseModel {
  public readonly firstName: string;
  public readonly lastName: string;
  public readonly email: string;
  public password: string;

  public readonly active: boolean;
  public readonly tenantId: number;
  public readonly defaultTenantId?: number;
  public readonly verifyToken: string;
  public readonly verified: boolean;
  public readonly inviteAcceptedAt!: string;

  // Microsoft SSO (Entra ID): `microsoftOid` is Microsoft's stable per-user,
  // per-tenant id (the `oid` claim), set the first time this account signs
  // in through Microsoft with a matching email.
  public microsoftOid: string | null;
  public ssoProvider: 'microsoft' | null;

  // TOTP two-factor authentication (the fallback for sign-in without SSO).
  // `mfaSecret` is encrypted at rest; never expose it or the recovery codes
  // outside the Mfa module.
  public mfaSecret: string | null;
  public mfaEnabled: boolean;
  public mfaEnrolledAt: string | null;
  public mfaRecoveryCodes: string | null;

  static get tableName() {
    return 'users';
  }

  /**
   * Model modifiers.
   */
  static get modifiers() {
    return {
      /**
       * Filters the invite accepted users.
       */
      inviteAccepted(query) {
        query.whereNotNull('invite_accepted_at');
      },

      active(query) {
        query.where('active', true);
      },
    };
  }

  async hashPassword(): Promise<void> {
    const salt = await bcrypt.genSalt();
    if (!/^\$2[abxy]?\$\d+\$/.test(this.password)) {
      this.password = await bcrypt.hash(this.password, salt);
    }
  }

  async checkPassword(plainPassword: string): Promise<boolean> {
    return await bcrypt.compare(plainPassword, this.password);
  }
}
