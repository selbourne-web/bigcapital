import { Fragment } from 'react';

/**
 * Renders text with its newlines as <br /> elements. `white-space: pre-line`
 * is ignored by Outlook, which then runs the paragraphs of a message together;
 * <br /> is honoured by every mail client.
 */
export const multiline = (text?: string | null) => {
  if (!text) return text;

  const lines = String(text).split(/\r?\n/);
  return lines.map((line, index) => (
    <Fragment key={index}>
      {line}
      {index < lines.length - 1 && <br />}
    </Fragment>
  ));
};
