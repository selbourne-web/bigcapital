import { Response } from 'express';
import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { GetDocumentView } from './GetDocumentView.service';
import { PublicRoute } from '../Auth/guards/jwt.guard';

/**
 * Public, read-only access to a shared estimate or credit note. The link id in
 * the url is the credential: an unguessable uuid created when the document is
 * emailed. Nothing here changes data.
 */
@Controller('document-views')
@ApiTags('Document Views')
@PublicRoute()
export class DocumentViewsController {
  constructor(private readonly documentView: GetDocumentView) {}

  @Get('/:linkId/estimate')
  @ApiOperation({ summary: 'Get a shared estimate' })
  @ApiParam({ name: 'linkId', type: 'string', required: true })
  @ApiResponse({ status: 404, description: 'Link not found' })
  public async getEstimate(@Param('linkId') linkId: string) {
    return { data: await this.documentView.getEstimateView(linkId) };
  }

  @Get('/:linkId/estimate/pdf')
  @ApiOperation({ summary: 'Get the PDF of a shared estimate' })
  @ApiParam({ name: 'linkId', type: 'string', required: true })
  @ApiResponse({ status: 404, description: 'Link not found' })
  public async getEstimatePdf(
    @Param('linkId') linkId: string,
    @Query('inline') inline: string,
    @Res() res: Response,
  ) {
    const [pdf, filename] = await this.documentView.getEstimatePdf(linkId);
    this.sendPdf(res, pdf, filename, inline);
  }

  @Get('/:linkId/credit-note')
  @ApiOperation({ summary: 'Get a shared credit note' })
  @ApiParam({ name: 'linkId', type: 'string', required: true })
  @ApiResponse({ status: 404, description: 'Link not found' })
  public async getCreditNote(@Param('linkId') linkId: string) {
    return { data: await this.documentView.getCreditNoteView(linkId) };
  }

  @Get('/:linkId/credit-note/pdf')
  @ApiOperation({ summary: 'Get the PDF of a shared credit note' })
  @ApiParam({ name: 'linkId', type: 'string', required: true })
  @ApiResponse({ status: 404, description: 'Link not found' })
  public async getCreditNotePdf(
    @Param('linkId') linkId: string,
    @Query('inline') inline: string,
    @Res() res: Response,
  ) {
    const [pdf, filename] = await this.documentView.getCreditNotePdf(linkId);
    this.sendPdf(res, pdf, filename, inline);
  }

  /** `inline=1` opens the PDF in the browser (to print); otherwise it downloads. */
  private sendPdf(
    res: Response,
    pdf: Buffer,
    filename: string,
    inline?: string,
  ) {
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Length': pdf.length,
      'Content-Disposition': `${
        inline === '1' ? 'inline' : 'attachment'
      }; filename="${filename}.pdf"`,
    });
    res.send(pdf);
  }
}
