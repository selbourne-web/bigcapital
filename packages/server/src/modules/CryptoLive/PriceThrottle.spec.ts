import { PriceQuote } from '../CryptoPrices/feeds/PriceFeed';
import { createPriceThrottle } from './PriceThrottle';

const quote = (asset: string, usd: number, extra: Partial<PriceQuote> = {}) =>
  ({
    asset,
    usd,
    source: 'kraken',
    asOf: 1000,
    stale: false,
    quote: 'USD',
    ...extra,
  }) as PriceQuote;

describe('createPriceThrottle', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('emits nothing until the interval elapses, then one batch with the LATEST quote per asset', () => {
    const emit = jest.fn();
    const throttle = createPriceThrottle(emit, 1000);

    throttle.push(quote('BTC', 100));
    throttle.push(quote('BTC', 101));
    throttle.push(quote('ETH', 10));
    throttle.push(quote('BTC', 102));
    expect(emit).not.toHaveBeenCalled();

    jest.advanceTimersByTime(999);
    expect(emit).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);

    expect(emit).toHaveBeenCalledTimes(1);
    const ticks: PriceQuote[] = emit.mock.calls[0][0];
    expect(ticks).toHaveLength(2);
    expect(ticks.find((t) => t.asset === 'BTC')?.usd).toBe(102);
    expect(ticks.find((t) => t.asset === 'ETH')?.usd).toBe(10);
  });

  it('flushes at most once per interval however many quotes arrive', () => {
    const emit = jest.fn();
    const throttle = createPriceThrottle(emit, 1000);

    for (let i = 0; i < 50; i++) {
      throttle.push(quote('BTC', 100 + i));
      jest.advanceTimersByTime(40); // 2s of traffic in total
    }
    // 2000ms elapsed -> at most 2 flushes, each with a single BTC tick
    expect(emit.mock.calls.length).toBeLessThanOrEqual(2);
    for (const [ticks] of emit.mock.calls) {
      expect(ticks.filter((t: PriceQuote) => t.asset === 'BTC')).toHaveLength(
        1,
      );
    }
  });

  it('forwards the contract fields untouched (quote, stale, source, asOf, change24hPct)', () => {
    const emit = jest.fn();
    const throttle = createPriceThrottle(emit);
    const q = quote('BTC', 64000.5, {
      source: 'binance',
      quote: 'USDT',
      stale: true,
      asOf: 1234,
      change24hPct: -1.5,
    });
    throttle.push(q);
    jest.advanceTimersByTime(1000);
    expect(emit).toHaveBeenCalledWith([q]);
  });

  it('keeps no timer when idle and re-arms on the next quote', () => {
    const emit = jest.fn();
    const throttle = createPriceThrottle(emit, 1000);
    expect(jest.getTimerCount()).toBe(0);

    throttle.push(quote('BTC', 1));
    expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(1000);
    expect(jest.getTimerCount()).toBe(0);

    throttle.push(quote('BTC', 2));
    jest.advanceTimersByTime(1000);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[1][0][0].usd).toBe(2);
  });

  it('stop() clears the timer and drops pending quotes', () => {
    const emit = jest.fn();
    const throttle = createPriceThrottle(emit, 1000);
    throttle.push(quote('BTC', 1));
    throttle.stop();
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(5000);
    expect(emit).not.toHaveBeenCalled();
  });

  it('a throwing emit does not escape the timer callback and the throttle keeps working', () => {
    const emit = jest
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('socket exploded');
      })
      .mockImplementation(() => undefined);
    const onError = jest.fn();
    const throttle = createPriceThrottle(emit, 1000, undefined, onError);

    throttle.push(quote('BTC', 1));
    expect(() => jest.advanceTimersByTime(1000)).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);

    throttle.push(quote('BTC', 2));
    jest.advanceTimersByTime(1000);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[1][0][0].usd).toBe(2);
  });

  it('swallows a throwing emit even without an error callback', () => {
    const throttle = createPriceThrottle(() => {
      throw new Error('boom');
    });
    throttle.push(quote('BTC', 1));
    expect(() => jest.advanceTimersByTime(1000)).not.toThrow();
  });

  it('uses injected timers', () => {
    const handle = {} as any;
    const timers = {
      setTimeout: jest.fn().mockReturnValue(handle),
      clearTimeout: jest.fn(),
    };
    const throttle = createPriceThrottle(jest.fn(), 250, timers);
    throttle.push(quote('BTC', 1));
    expect(timers.setTimeout).toHaveBeenCalledWith(expect.any(Function), 250);
    throttle.stop();
    expect(timers.clearTimeout).toHaveBeenCalledWith(handle);
  });
});
