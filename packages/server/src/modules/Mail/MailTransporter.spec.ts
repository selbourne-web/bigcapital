import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { createTransport, Transporter } from 'nodemailer';
import { Mail } from './Mail';
import { MailModule } from './Mail.module';
import { MAIL_TRANSPORTER_PROVIDER } from './Mail.constants';
import { MailTransporter } from './MailTransporter.service';

// 1x1 transparent PNG.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/**
 * Builds a transporter that renders the message into a buffer instead of
 * delivering it: no network access.
 */
const createStreamTransporter = (): Transporter =>
  createTransport({ streamTransport: true, buffer: true, newline: 'unix' });

const sendRaw = async (mail: Mail) => {
  const transporter = new MailTransporter(createStreamTransporter());
  const info = await transporter.send(mail);
  return { info, raw: (info.message as Buffer).toString('utf8') };
};

describe('MailTransporter (nodemailer message building)', () => {
  it('builds subject, html body and file attachments', async () => {
    const mail = new Mail()
      .setFrom('Bigcapital <noreply@bigcapital.example>')
      .setTo('customer@bigcapital.example')
      .setCC(['cc@bigcapital.example'])
      .setReplyTo('accounts@bigcapital.example')
      .setSubject('Invoice INV-00042 from Acme')
      .setContent('<p>Hello, your invoice is attached.</p>')
      .setAttachments([
        {
          filename: 'INV-00042.pdf',
          content: Buffer.from('%PDF-1.4 fake'),
        },
      ]);

    const { info, raw } = await sendRaw(mail);

    expect(info.envelope).toEqual({
      from: 'noreply@bigcapital.example',
      to: ['customer@bigcapital.example', 'cc@bigcapital.example'],
    });
    expect(raw).toContain('Subject: Invoice INV-00042 from Acme');
    expect(raw).toContain('Reply-To: accounts@bigcapital.example');
    expect(raw).toMatch(/Content-Type: text\/html/);
    expect(raw).toContain('<p>Hello, your invoice is attached.</p>');
    expect(raw).toMatch(/filename=INV-00042\.pdf/);
    expect(raw).toContain(Buffer.from('%PDF-1.4 fake').toString('base64'));
  });

  it('sends data: URI images as inline cid attachments', async () => {
    const mail = new Mail()
      .setFrom('noreply@bigcapital.example')
      .setTo('customer@bigcapital.example')
      .setSubject('Logo')
      .setContent(`<img src="data:image/png;base64,${PNG_BASE64}" />`);

    const { raw } = await sendRaw(mail);

    const cid = raw.match(/src="cid:([0-9a-f]{16}@inline)"/)?.[1];
    expect(cid).toBeDefined();
    expect(raw).not.toContain('data:image/png');
    expect(raw).toContain(`Content-ID: <${cid}>`);
    expect(raw).toMatch(/Content-Disposition: inline; filename=logo-1\.png/);
    expect(raw).toContain('Content-Type: image/png');
  });

  // GHSA-mm7p-fcc7-pg87 (nodemailer < 7.0.7): a quoted local part containing
  // an "@" was split so the message could go to an unintended domain.
  it('does not deliver to a domain hidden in a quoted local part', async () => {
    const mail = new Mail()
      .setFrom('noreply@bigcapital.example')
      .setTo('"attacker@evil.example x"@bigcapital.example')
      .setSubject('Hello')
      .setContent('<p>Hi</p>');

    const recipients = await sendRaw(mail)
      .then(({ info }) => info.envelope.to as string[])
      .catch(() => [] as string[]);

    expect(recipients.some((to) => /evil\.example$/.test(to))).toBe(false);
  });
});

describe('MailModule transporter factory', () => {
  const buildTransporter = async (mail: Record<string, unknown>) => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ mail })],
        }),
        MailModule,
      ],
    }).compile();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transporter = moduleRef.get<any>(MAIL_TRANSPORTER_PROVIDER);
    const options = transporter.transporter.options;
    transporter.close();
    return { transporter, options };
  };

  it('creates an SMTP transport with credentials when configured', async () => {
    const { transporter, options } = await buildTransporter({
      host: 'smtp.bigcapital.example',
      port: 587,
      secure: false,
      username: 'user',
      password: 'secret',
    });

    expect(transporter.transporter.name).toBe('SMTP');
    expect(options).toMatchObject({
      host: 'smtp.bigcapital.example',
      port: 587,
      secure: false,
      auth: { user: 'user', pass: 'secret' },
    });
  });

  it('omits auth for no-auth relays', async () => {
    const { options } = await buildTransporter({
      host: 'relay.bigcapital.example',
      port: 25,
      secure: false,
    });

    expect(options.host).toBe('relay.bigcapital.example');
    expect(options.auth).toBeUndefined();
  });
});
