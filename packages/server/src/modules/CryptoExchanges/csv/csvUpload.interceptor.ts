import {
  ExecutionContext,
  CallHandler,
  HttpException,
  PayloadTooLargeException,
  mixin,
  NestInterceptor,
  Type,
} from '@nestjs/common';
import { memoryStorage } from 'multer';
import { Observable } from 'rxjs';
import { FileInterceptor } from '@/common/interceptors/file.interceptor';
import { CSV_LIMITS } from '../CryptoExchanges.constants';
import { CsvImportError } from './csv.types';

/** Mimetypes browsers and OSes attach to a `.csv` file; the content is judged by the parser. */
export const CSV_UPLOAD_MIMETYPES: ReadonlySet<string> = new Set([
  'text/csv',
  'application/vnd.ms-excel',
  'text/plain',
  'application/octet-stream',
]);

/** multer `fileFilter`: `.csv` extension and a text-ish mimetype, else CSV_FORMAT_UNRECOGNIZED. */
export function csvFileFilter(
  _req: unknown,
  file: { originalname?: string; mimetype?: string },
  cb: (error: Error | null, accept?: boolean) => void,
) {
  const name = String(file?.originalname ?? '');
  const type = String(file?.mimetype ?? '')
    .toLowerCase()
    .split(';')[0]
    .trim();
  if (!/\.csv$/i.test(name) || !CSV_UPLOAD_MIMETYPES.has(type)) {
    cb(
      new CsvImportError(
        'CSV_FORMAT_UNRECOGNIZED',
        'Upload a .csv file exported from the exchange.',
      ),
    );
    return;
  }
  cb(null, true);
}

/**
 * Single `file` field, memory storage (nothing touches disk), one file, the
 * CSV size cap. Local options win over the app-wide MULTER_MODULE_OPTIONS
 * (the shared FileInterceptor spreads them last), so the attachment module's
 * disk storage and limits never apply here.
 */
export function CsvUploadInterceptor(): Type<NestInterceptor> {
  const Base = FileInterceptor('file', {
    storage: memoryStorage(),
    limits: { fileSize: CSV_LIMITS.maxBytes, files: 1, fields: 5, parts: 6 },
    fileFilter: csvFileFilter as any,
  });

  class CsvUpload extends Base {
    async intercept(
      context: ExecutionContext,
      next: CallHandler,
    ): Promise<Observable<any>> {
      try {
        return await super.intercept(context, next);
      } catch (error) {
        if (error instanceof PayloadTooLargeException) {
          throw new CsvImportError(
            'CSV_TOO_LARGE',
            `The file is larger than the ${CSV_LIMITS.maxBytes / (1024 * 1024)} MB limit.`,
          );
        }
        // Too many files, an unexpected field name, a broken multipart body:
        // multer's 400s become the one stable code instead of leaking its text.
        if (error instanceof HttpException && error.getStatus() === 400) {
          throw new CsvImportError(
            'CSV_FORMAT_UNRECOGNIZED',
            'Upload exactly one .csv file in the `file` field.',
          );
        }
        throw error;
      }
    }
  }
  return mixin(CsvUpload);
}
