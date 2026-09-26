import { createHash } from 'crypto';
import { Transporter } from 'nodemailer';
import { Mail } from './Mail';
import { Inject, Injectable } from '@nestjs/common';
import { MAIL_TRANSPORTER_PROVIDER } from './Mail.constants';

const DATA_URI_IMAGE = /data:image\/(png|jpe?g|gif);base64,([A-Za-z0-9+/=]+)/g;

@Injectable()
export class MailTransporter {
  constructor(
    @Inject(MAIL_TRANSPORTER_PROVIDER)
    private readonly transporter: Transporter,
  ) {}

  send(mail: Mail) {
    return this.transporter.sendMail(
      MailTransporter.inlineDataUriImages(mail.mailOptions),
    );
  }

  /**
   * Mail clients (Gmail, Outlook) do not render `data:` images, so images
   * embedded that way in the html, such as the company logo, are sent as inline
   * attachments referenced by `cid:` instead.
   * @param {Record<string, any>} options - Nodemailer mail options.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static inlineDataUriImages(options: Record<string, any>) {
    if (typeof options.html !== 'string') return options;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inline: any[] = [];
    const html = options.html.replace(
      DATA_URI_IMAGE,
      (_match: string, type: string, base64: string) => {
        const extension = type === 'jpeg' ? 'jpg' : type;
        const cid = `${createHash('sha1')
          .update(base64)
          .digest('hex')
          .slice(0, 16)}@inline`;

        if (!inline.some((attachment) => attachment.cid === cid)) {
          inline.push({
            filename: `logo-${inline.length + 1}.${extension}`,
            content: Buffer.from(base64, 'base64'),
            contentType: `image/${type === 'jpg' ? 'jpeg' : type}`,
            cid,
          });
        }
        return `cid:${cid}`;
      },
    );
    if (!inline.length) return options;

    return {
      ...options,
      html,
      attachments: [...(options.attachments ?? []), ...inline],
    };
  }
}
