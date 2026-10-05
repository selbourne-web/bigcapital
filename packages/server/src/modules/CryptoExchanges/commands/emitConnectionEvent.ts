import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { Knex } from 'knex';
import { CryptoConnectionEventPayload } from '../CryptoExchanges.events';

/** Emits a crypto connection event with the tenant's organization id and the open trx. */
export const emitConnectionEvent = (
  eventEmitter: EventEmitter2,
  cls: ClsService,
  name: string,
  connectionId: number,
  trx: Knex.Transaction,
) =>
  eventEmitter.emitAsync(name, {
    connectionId,
    organizationId: cls.get<number>('organizationId'),
    trx,
  } as CryptoConnectionEventPayload);
