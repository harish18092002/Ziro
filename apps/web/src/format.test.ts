import { describe, expect, it } from 'vitest';
import { inr, linkTo, parseHash, percent, words } from './format';

const RUN = '3f2b8c1e-5d4a-4b6f-9a7e-1c2d3e4f5a6b';
const ITEM = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

describe('inr', () => {
  it.each([
    ['0', '₹0.00'],
    ['5', '₹0.05'],
    ['12345650', '₹1,23,456.50'],
    ['-47300', '-₹473.00'],
  ])('%s paise is %s', (paise, shown) => {
    expect(inr(paise)).toBe(shown);
  });

  it('shows a dash for anything that is not integer paise, never a guess', () => {
    for (const bad of [null, undefined, '', '12.5', 'abc', '1e3']) expect(inr(bad)).toBe('–');
  });
});

describe('parseHash', () => {
  it('is the home page for anything that is not a run', () => {
    for (const hash of ['', '#', '#/', '#/runs', '#/runs/not-a-uuid/summary', '#/other'])
      expect(parseHash(hash)).toEqual({ page: 'home' });
  });

  it('reads a run, its tab and an optional item', () => {
    expect(parseHash(`#/runs/${RUN}`)).toEqual({
      page: 'run',
      runId: RUN,
      tab: 'summary',
      itemId: null,
    });
    expect(parseHash(`#/runs/${RUN}/exceptions/${ITEM}`)).toEqual({
      page: 'run',
      runId: RUN,
      tab: 'exceptions',
      itemId: ITEM,
    });
  });

  it('falls back to the summary for an unknown tab and drops a malformed item id', () => {
    expect(parseHash(`#/runs/${RUN}/nonsense/x`)).toEqual({
      page: 'run',
      runId: RUN,
      tab: 'summary',
      itemId: null,
    });
  });

  it('round-trips through linkTo', () => {
    expect(parseHash(linkTo(RUN, 'audit', ITEM))).toEqual({
      page: 'run',
      runId: RUN,
      tab: 'audit',
      itemId: ITEM,
    });
  });
});

describe('small formatters', () => {
  it('formats shares and reason codes', () => {
    expect(percent(0.9732)).toBe('97.3%');
    expect(percent(null)).toBe('–');
    expect(words('FEE_GST_DEDUCTION')).toBe('fee gst deduction');
  });
});
