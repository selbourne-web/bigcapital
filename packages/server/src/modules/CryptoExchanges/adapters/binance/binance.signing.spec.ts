import { signBinance } from './binance.signing';

// Inputs and expected output copied from Binance's published example:
// https://developers.binance.com/docs/binance-spot-api-docs/rest-api/request-security
describe('signBinance', () => {
  it('matches the signature published in the Binance docs', () => {
    const secret =
      'NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j';
    const query =
      'symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559';
    expect(signBinance(query, secret)).toBe(
      'c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71',
    );
  });
});
