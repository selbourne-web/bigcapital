import { signKraken } from './kraken.signing';

// Inputs and expected output copied from Kraken's published example:
// https://docs.kraken.com/api/docs/guides/spot-rest-auth
describe('signKraken', () => {
  it('matches the signature published in the Kraken docs', () => {
    const secret =
      'kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==';
    const nonce = '1616492376594';
    const body =
      'nonce=1616492376594&ordertype=limit&pair=XBTUSD&price=37500&type=buy&volume=1.25';
    expect(signKraken('/0/private/AddOrder', nonce, body, secret)).toBe(
      '4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ==',
    );
  });
});
