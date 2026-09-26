import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_LOGO_FILE = path.join(
  __dirname,
  '../../..',
  'static/images/selbourne-logo.png',
);

let cachedLogoUri: string | null | undefined;

/**
 * The Selbourne logo as a data URI, so it renders wherever a company logo is
 * expected (PDF documents rendered by Gotenberg, previews, mail) without
 * needing a URL the renderer or recipient can reach. Mail is converted to an
 * inline attachment on send, see `MailTransporter`.
 * @returns {string | null} Null when the logo file cannot be read.
 */
export const getDefaultCompanyLogoUri = (): string | null => {
  if (cachedLogoUri !== undefined) return cachedLogoUri;

  try {
    cachedLogoUri = `data:image/png;base64,${fs
      .readFileSync(DEFAULT_LOGO_FILE)
      .toString('base64')}`;
  } catch {
    cachedLogoUri = null;
  }
  return cachedLogoUri;
};

/**
 * The given company logo when one is set (an uploaded organization or template
 * logo), otherwise the default Selbourne logo.
 * @param {string | null} [logoUri]
 * @returns {string | null}
 */
export const withDefaultCompanyLogo = (
  logoUri?: string | null,
): string | null => logoUri || getDefaultCompanyLogoUri();
