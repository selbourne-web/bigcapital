import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiCommonHeaders } from '@/common/decorators/ApiCommonHeaders';
import { AuthorizationGuard } from '@/modules/Roles/Authorization.guard';
import { PermissionGuard } from '@/modules/Roles/Permission.guard';
import { RequirePermission } from '@/modules/Roles/RequirePermission.decorator';
import { AbilitySubject } from '@/modules/Roles/Roles.types';
import { CryptoExchangeAction as Action } from './CryptoExchanges.constants';
import { CryptoExchangeExceptionFilter } from './CryptoExchanges.filter';
import { CreateCryptoConnectionDto } from './dtos/CreateCryptoConnection.dto';
import { UpdateCryptoConnectionDto } from './dtos/UpdateCryptoConnection.dto';
import { RotateCredentialsDto } from './dtos/RotateCredentials.dto';
import { GetCryptoSyncRunsQueryDto } from './dtos/GetCryptoSyncRunsQuery.dto';
import { DeleteCryptoConnectionQueryDto } from './dtos/DeleteCryptoConnectionQuery.dto';
import { CreateCryptoConnectionService } from './commands/CreateCryptoConnection.service';
import { UpdateCryptoConnectionService } from './commands/UpdateCryptoConnection.service';
import { RotateCryptoCredentialsService } from './commands/RotateCryptoCredentials.service';
import { DeleteCryptoConnectionService } from './commands/DeleteCryptoConnection.service';
import { GetCryptoConnectionsService } from './queries/GetCryptoConnections.service';
import { GetCryptoBalancesService } from './queries/GetCryptoBalances.service';
import { GetCryptoSyncRunsService } from './queries/GetCryptoSyncRuns.service';
import { CryptoSyncRequestService } from './sync/CryptoSyncRequest.service';

/**
 * REST API of the crypto exchange connectors (`/api/crypto`).
 *
 * Permissions (subject `CryptoExchange`): reading = View, creating a
 * connection = Create, changing one (rename, pause/resume, account mapping,
 * credential rotation) and requesting a manual sync = Edit, removing = Delete.
 * A manual sync is Edit rather than Create because it triggers work on an
 * existing connection and creates no record the user owns.
 *
 * No response ever carries credentials or ciphertext: connections are returned
 * through the `CryptoConnectionView` allow-list.
 */
@Controller('crypto')
@ApiTags('Crypto Exchanges')
@ApiCommonHeaders()
@UseGuards(AuthorizationGuard, PermissionGuard)
@UseFilters(CryptoExchangeExceptionFilter)
export class CryptoExchangesController {
  constructor(
    private readonly getConnections: GetCryptoConnectionsService,
    private readonly getBalances: GetCryptoBalancesService,
    private readonly getSyncRuns: GetCryptoSyncRunsService,
    private readonly createConnection: CreateCryptoConnectionService,
    private readonly updateConnection: UpdateCryptoConnectionService,
    private readonly rotateCredentials: RotateCryptoCredentialsService,
    private readonly deleteConnection: DeleteCryptoConnectionService,
    private readonly syncRequests: CryptoSyncRequestService,
  ) {}

  @Get('connections')
  @RequirePermission(Action.View, AbilitySubject.CryptoExchange)
  @ApiOperation({ summary: 'List the crypto exchange connections.' })
  @ApiResponse({
    status: 200,
    description: 'The connections (no credentials).',
  })
  async listConnections() {
    const connections = await this.getConnections.execute();
    // Best effort and never throws: restores repeatable sync jobs lost with Redis data.
    await this.syncRequests.selfHeal(connections);
    return connections;
  }

  @Post('connections')
  @RequirePermission(Action.Create, AbilitySubject.CryptoExchange)
  @ApiOperation({
    summary:
      'Connect an exchange with a read-only API key (422 KEY_HAS_EXTRA_PERMISSIONS / ATTESTATION_REQUIRED).',
  })
  @ApiResponse({ status: 201, description: 'The created connection.' })
  @ApiResponse({
    status: 422,
    description:
      'The key can do more than read (code KEY_HAS_EXTRA_PERMISSIONS, with the permission names), or read-only status could not be verified (code ATTESTATION_REQUIRED).',
  })
  createCryptoConnection(@Body() dto: CreateCryptoConnectionDto) {
    return this.createConnection.execute(dto);
  }

  @Patch('connections/:id')
  @RequirePermission(Action.Edit, AbilitySubject.CryptoExchange)
  @ApiOperation({
    summary: 'Rename, pause/resume or re-map the account of a connection.',
  })
  updateCryptoConnection(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCryptoConnectionDto,
  ) {
    return this.updateConnection.execute(id, dto);
  }

  @Delete('connections/:id')
  @RequirePermission(Action.Delete, AbilitySubject.CryptoExchange)
  @ApiOperation({
    summary:
      'Remove a connection and its credentials; stored data is kept unless deleteData=true.',
  })
  async deleteCryptoConnection(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: DeleteCryptoConnectionQueryDto,
  ) {
    await this.deleteConnection.execute(id, {
      deleteData: query.deleteData === true,
    });
  }

  @Post('connections/:id/credentials')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(Action.Edit, AbilitySubject.CryptoExchange)
  @ApiOperation({
    summary:
      'Replace the API credentials of a connection (re-verified read-only).',
  })
  rotateCryptoCredentials(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RotateCredentialsDto,
  ) {
    return this.rotateCredentials.execute(id, dto);
  }

  @Post('connections/:id/sync')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission(Action.Edit, AbilitySubject.CryptoExchange)
  @ApiOperation({
    summary: 'Queue a manual sync (one per connection per 60 seconds).',
  })
  @ApiResponse({ status: 202, description: '{ queued: true }' })
  @ApiResponse({
    status: 429,
    description: 'Requested again within 60 s; see the Retry-After header.',
  })
  async syncCryptoConnection(@Param('id', ParseIntPipe) id: number) {
    await this.syncRequests.requestManualSync(id);
    return { queued: true };
  }

  @Get('balances')
  @RequirePermission(Action.View, AbilitySubject.CryptoExchange)
  @ApiOperation({
    summary: 'Latest balance per asset of every connection (decimal strings).',
  })
  cryptoBalances() {
    return this.getBalances.execute();
  }

  @Get('sync-runs')
  @RequirePermission(Action.View, AbilitySubject.CryptoExchange)
  @ApiOperation({ summary: 'Recent sync runs, newest first.' })
  cryptoSyncRuns(@Query() query: GetCryptoSyncRunsQueryDto) {
    return this.getSyncRuns.execute(query);
  }
}
