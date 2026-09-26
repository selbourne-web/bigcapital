import { Injectable } from '@nestjs/common';
import { TenancyContext } from '../Tenancy/TenancyContext.service';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class MailTenancy {
  constructor(
    private readonly tenancyContext: TenancyContext,
    private readonly config: ConfigService,
  ) {}

  /**
   * Retrieves the senders mails of the given tenant.
   */
  public async senders() {
    const tenantMetadata = await this.tenancyContext.getTenantMetadata();
    // `mail.from` is a `{ name, address }` pair; only the address is the sender mail.
    const from = this.config.get('mail.from');

    return [
      {
        mail: from?.address,
        label: tenantMetadata.name,
        primary: true,
      },
    ].filter((item) => item.mail);
  }
}
