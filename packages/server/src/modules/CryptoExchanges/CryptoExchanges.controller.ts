import {
  Body,
  Controller,
  ForbiddenException,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { ApiCommonHeaders } from '@/common/decorators/ApiCommonHeaders';
import { AuthorizationGuard } from '@/modules/Roles/Authorization.guard';
import { PermissionGuard } from '@/modules/Roles/Permission.guard';
import { RequirePermission } from '@/modules/Roles/RequirePermission.decorator';
import { AbilitySubject } from '@/modules/Roles/Roles.types';
import { AccountAction } from '@/modules/Accounts/Accounts.types';
import { CryptoExchangeAction as Action } from './CryptoExchanges.constants';
import { CryptoExchangeExceptionFilter } from './CryptoExchanges.filter';
import { ERROR_NOTE, EXAMPLES, res } from './CryptoExchanges.swagger';
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
import { CsvImportError } from './csv/csv.types';
import { CsvUploadInterceptor } from './csv/csvUpload.interceptor';
import { PreviewCryptoCsvImportService } from './commands/PreviewCryptoCsvImport.service';
import { CommitCryptoCsvImportService } from './commands/CommitCryptoCsvImport.service';
import { RollbackCryptoCsvImportService } from './commands/RollbackCryptoCsvImport.service';
import { GetCryptoCsvImportsService } from './queries/GetCryptoCsvImports.service';

type UploadedCsv = { buffer?: Buffer; originalname?: string };

/** The uploaded file, or 422 CSV_FORMAT_UNRECOGNIZED when the part is missing. */
const requireCsv = (file?: UploadedCsv) => {
  if (!file?.buffer) {
    throw new CsvImportError('CSV_FORMAT_UNRECOGNIZED', 'No file uploaded');
  }
  return { buffer: file.buffer, originalname: String(file.originalname ?? '') };
};

const csvUploadBody = {
  schema: {
    type: 'object',
    required: ['file'],
    properties: { file: { type: 'string', format: 'binary' } },
  },
};

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
    private readonly previewCsv: PreviewCryptoCsvImportService,
    private readonly commitCsv: CommitCryptoCsvImportService,
    private readonly rollbackCsv: RollbackCryptoCsvImportService,
    private readonly listCsvImports: GetCryptoCsvImportsService,
    private readonly cls: ClsService,
  ) {}

  @Get('connections')
  @RequirePermission(Action.View, AbilitySubject.CryptoExchange)
  @ApiOperation({ summary: 'List the crypto exchange connections.' })
  @ApiResponse(
    res(
      200,
      'The connections (no credentials); snake_case keys.',
      EXAMPLES.connections,
    ),
  )
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
    description:
      'Needs Create on CryptoExchange; with `createAccount: true` it also needs Create on Account (403 otherwise).',
  })
  @ApiResponse(
    res(201, 'The created connection; snake_case keys.', EXAMPLES.connection),
  )
  @ApiResponse(
    res(
      400,
      'Validation failure (account type/currency/not found, bad body).' +
        ERROR_NOTE,
      EXAMPLES.serviceError(
        'CRYPTO_ACCOUNT_NOT_ASSET',
        'Only an asset account can hold a crypto connection.',
        400,
      ),
    ),
  )
  @ApiResponse(
    res(
      409,
      'The account is already mapped to another connection.',
      EXAMPLES.serviceError(
        'CRYPTO_ACCOUNT_ALREADY_MAPPED',
        'This account is already mapped to crypto connection Kraken - Trading.',
        409,
      ),
    ),
  )
  @ApiResponse(
    res(
      422,
      'The key can do more than read (KEY_HAS_EXTRA_PERMISSIONS, with the permission names; shown), or read-only status could not be verified ({ "code": "ATTESTATION_REQUIRED", "permissions": [...], "warnings": [...] }, resend with attestReadOnly: true).' +
        ERROR_NOTE,
      EXAMPLES.keyHasExtraPermissions,
    ),
  )
  @ApiResponse(
    res(
      429,
      'The exchange is rate limiting (EXCHANGE_RATE_LIMITED).' + ERROR_NOTE,
      {
        code: 'EXCHANGE_RATE_LIMITED',
        message:
          'The exchange is rate limiting requests. The sync will retry shortly.',
      },
    ),
  )
  createCryptoConnection(
    @Body() dto: CreateCryptoConnectionDto,
    @Req() request?: { ability?: { can: (a: string, s: string) => boolean } },
  ) {
    // `createAccount: true` also writes to the chart of accounts, so it needs the
    // Account Create permission on top of CryptoExchange Create (fails closed).
    if (
      dto.createAccount === true &&
      !request?.ability?.can(AccountAction.CREATE, AbilitySubject.Account)
    ) {
      throw new ForbiddenException(
        'You do not have permission to Create Account',
      );
    }
    return this.createConnection.execute(dto);
  }

  @Patch('connections/:id')
  @RequirePermission(Action.Edit, AbilitySubject.CryptoExchange)
  @ApiOperation({
    summary: 'Rename, pause/resume or re-map the account of a connection.',
  })
  @ApiResponse(
    res(200, 'The updated connection; snake_case keys.', EXAMPLES.connection),
  )
  @ApiResponse(
    res(
      404,
      'Unknown or archived connection.',
      EXAMPLES.serviceError(
        'CRYPTO_CONNECTION_NOT_FOUND',
        'Crypto connection not found.',
        404,
      ),
    ),
  )
  @ApiResponse(
    res(
      409,
      'Conflict: account already mapped, or the connection is in error (rotate credentials).',
      EXAMPLES.serviceError(
        'CRYPTO_CONNECTION_IN_ERROR',
        'This connection has an error. Replace its credentials to reconnect.',
        409,
      ),
    ),
  )
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
  @ApiResponse(res(200, 'Removed; the body is empty.', ''))
  @ApiResponse(
    res(
      404,
      'Unknown or archived connection.',
      EXAMPLES.serviceError(
        'CRYPTO_CONNECTION_NOT_FOUND',
        'Crypto connection not found.',
        404,
      ),
    ),
  )
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
  @ApiResponse(
    res(
      200,
      'The reactivated connection; snake_case keys.',
      EXAMPLES.connection,
    ),
  )
  @ApiResponse(
    res(
      404,
      'Unknown or archived connection.',
      EXAMPLES.serviceError(
        'CRYPTO_CONNECTION_NOT_FOUND',
        'Crypto connection not found.',
        404,
      ),
    ),
  )
  @ApiResponse(
    res(
      422,
      'The new key is rejected (EXCHANGE_AUTH_FAILED), has extra permissions (KEY_HAS_EXTRA_PERMISSIONS) or needs attestation (ATTESTATION_REQUIRED).' +
        ERROR_NOTE,
      EXAMPLES.exchangeAuth,
    ),
  )
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
  @ApiResponse(
    res(202, 'Queued; the sync runs on the worker.', EXAMPLES.queued),
  )
  @ApiResponse(
    res(
      404,
      'Unknown or archived connection.',
      EXAMPLES.serviceError(
        'CRYPTO_CONNECTION_NOT_FOUND',
        'Crypto connection not found.',
        404,
      ),
    ),
  )
  @ApiResponse(
    res(
      409,
      'The connection is paused.',
      EXAMPLES.serviceError(
        'CRYPTO_CONNECTION_PAUSED',
        'This connection is paused. Resume it to sync.',
        409,
      ),
    ),
  )
  @ApiResponse(
    res(
      429,
      'Requested again within 60 s; see the Retry-After header (seconds).' +
        ERROR_NOTE,
      EXAMPLES.throttled,
    ),
  )
  async syncCryptoConnection(@Param('id', ParseIntPipe) id: number) {
    await this.syncRequests.requestManualSync(id);
    return { queued: true };
  }

  @Get('balances')
  @RequirePermission(Action.View, AbilitySubject.CryptoExchange)
  @ApiOperation({
    summary: 'Latest balance per asset of every connection (decimal strings).',
  })
  @ApiResponse(
    res(
      200,
      'Latest non-zero balance per asset per connection; decimals are strings; snake_case keys.',
      EXAMPLES.balances,
    ),
  )
  cryptoBalances() {
    return this.getBalances.execute();
  }

  @Get('sync-runs')
  @RequirePermission(Action.View, AbilitySubject.CryptoExchange)
  @ApiOperation({ summary: 'Recent sync runs, newest first.' })
  @ApiResponse(res(200, 'Sync runs; snake_case keys.', EXAMPLES.syncRuns))
  cryptoSyncRuns(@Query() query: GetCryptoSyncRunsQueryDto) {
    return this.getSyncRuns.execute(query);
  }

  @Post('connections/:id/imports')
  @RequirePermission(Action.Create, AbilitySubject.CryptoExchange)
  @UseInterceptors(CsvUploadInterceptor())
  @ApiConsumes('multipart/form-data')
  @ApiBody(csvUploadBody)
  @ApiOperation({
    summary:
      'Upload an exchange CSV report and preview what importing it would do (nothing is stored yet).',
    description:
      'Multipart field `file`, one .csv up to 10 MB, held in memory only. Needs Create on CryptoExchange. The preview is valid for 24 hours; commit it by re-sending the same file.',
  })
  @ApiResponse(res(201, 'The preview; snake_case keys.', EXAMPLES.csvPreview))
  @ApiResponse(
    res(
      404,
      'Unknown or archived connection.',
      EXAMPLES.serviceError(
        'CRYPTO_CONNECTION_NOT_FOUND',
        'Crypto connection not found.',
        404,
      ),
    ),
  )
  @ApiResponse(
    res(
      409,
      'CSV_DUPLICATE_FILE: this exact file was already imported for the connection.' +
        ERROR_NOTE,
      EXAMPLES.csvError(
        'CSV_DUPLICATE_FILE',
        'This file has already been imported for this connection.',
      ),
    ),
  )
  @ApiResponse(
    res(
      413,
      'CSV_TOO_LARGE: the file is over 10 MB.' + ERROR_NOTE,
      EXAMPLES.csvError(
        'CSV_TOO_LARGE',
        'The file is larger than the 10 MB limit.',
      ),
    ),
  )
  @ApiResponse(
    res(
      422,
      'CSV_FORMAT_UNRECOGNIZED (no file, not a .csv, or an unknown report), CSV_DERIVED_EXPORT_REFUSED or CSV_MALFORMED.' +
        ERROR_NOTE,
      EXAMPLES.csvError(
        'CSV_FORMAT_UNRECOGNIZED',
        'Upload a .csv file exported from the exchange.',
      ),
    ),
  )
  previewCryptoCsv(
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() file?: UploadedCsv,
  ) {
    return this.previewCsv.execute(
      id,
      requireCsv(file),
      Number(this.cls.get('userId')),
    );
  }

  @Post('imports/:importId/commit')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(Action.Create, AbilitySubject.CryptoExchange)
  @UseInterceptors(CsvUploadInterceptor())
  @ApiConsumes('multipart/form-data')
  @ApiBody(csvUploadBody)
  @ApiOperation({
    summary:
      'Commit a previewed import by re-sending the same file (all or nothing).',
    description:
      'Multipart field `file`. The file must be byte-identical to the previewed one. Needs Create on CryptoExchange.',
  })
  @ApiResponse(
    res(200, 'The committed import; snake_case keys.', EXAMPLES.csvImport),
  )
  @ApiResponse(
    res(
      404,
      'Unknown import or archived connection.',
      EXAMPLES.serviceError(
        'CRYPTO_CSV_IMPORT_NOT_FOUND',
        'CSV import not found.',
        404,
      ),
    ),
  )
  @ApiResponse(
    res(
      409,
      'CSV_FILE_CHANGED (different bytes than previewed) or CSV_NOT_COMMITTABLE (already committed or rolled back).' +
        ERROR_NOTE,
      EXAMPLES.csvError(
        'CSV_FILE_CHANGED',
        'The file differs from the one that was previewed. Upload and preview it again.',
      ),
    ),
  )
  @ApiResponse(
    res(
      413,
      'CSV_TOO_LARGE.' + ERROR_NOTE,
      EXAMPLES.csvError(
        'CSV_TOO_LARGE',
        'The file is larger than the 10 MB limit.',
      ),
    ),
  )
  @ApiResponse(
    res(
      422,
      'CSV_FORMAT_UNRECOGNIZED or CSV_MALFORMED.' + ERROR_NOTE,
      EXAMPLES.csvError(
        'CSV_FORMAT_UNRECOGNIZED',
        'Upload a .csv file exported from the exchange.',
      ),
    ),
  )
  @ApiResponse(
    res(
      503,
      'CSV_BUSY: the database was busy (lock wait or deadlock); nothing was changed. Retry after the Retry-After seconds.' +
        ERROR_NOTE,
      EXAMPLES.csvError(
        'CSV_BUSY',
        'The database was busy. Nothing was changed; please try again.',
      ),
    ),
  )
  commitCryptoCsv(
    @Param('importId', ParseIntPipe) importId: number,
    @UploadedFile() file?: UploadedCsv,
  ) {
    return this.commitCsv.execute(importId, requireCsv(file));
  }

  @Get('connections/:id/imports')
  @RequirePermission(Action.View, AbilitySubject.CryptoExchange)
  @ApiOperation({
    summary: 'CSV import history of a connection, newest first.',
  })
  @ApiResponse(res(200, 'The imports; snake_case keys.', [EXAMPLES.csvImport]))
  @ApiResponse(
    res(
      404,
      'Unknown or archived connection.',
      EXAMPLES.serviceError(
        'CRYPTO_CONNECTION_NOT_FOUND',
        'Crypto connection not found.',
        404,
      ),
    ),
  )
  listCryptoCsvImports(@Param('id', ParseIntPipe) id: number) {
    return this.listCsvImports.execute(id);
  }

  @Delete('imports/:importId')
  @RequirePermission(Action.Delete, AbilitySubject.CryptoExchange)
  @ApiOperation({
    summary:
      'Roll back a committed import (removes exactly the rows it wrote).',
    description: 'Needs Delete on CryptoExchange.',
  })
  @ApiResponse(
    res(200, 'The rolled-back import; snake_case keys.', {
      ...EXAMPLES.csvImport,
      status: 'rolled_back',
    }),
  )
  @ApiResponse(
    res(
      404,
      'Unknown import.',
      EXAMPLES.serviceError(
        'CRYPTO_CSV_IMPORT_NOT_FOUND',
        'CSV import not found.',
        404,
      ),
    ),
  )
  @ApiResponse(
    res(
      409,
      'CSV_NOT_ROLLBACKABLE: not committed, or later imports skipped rows this one wrote (dependentImportIds lists them; roll those back first).' +
        ERROR_NOTE,
      EXAMPLES.csvError(
        'CSV_NOT_ROLLBACKABLE',
        'Roll back the later import(s) first (13): they skipped rows that this import wrote.',
        { dependentImportIds: [13] },
      ),
    ),
  )
  rollbackCryptoCsv(@Param('importId', ParseIntPipe) importId: number) {
    return this.rollbackCsv.execute(importId);
  }
}
