import { test, expect, describe } from 'bun:test';

import { asObject, asArray, asString, asBool, asNumber, itemsOf } from './shared';

describe('JSON coercion helpers', () => {
  test('asObject accepts plain objects only', () => {
    expect(asObject({ a: 1 })).toEqual({ a: 1 });
    expect(asObject([1, 2])).toBeUndefined();
    expect(asObject(null)).toBeUndefined();
    expect(asObject('x')).toBeUndefined();
  });

  test('asArray accepts arrays only', () => {
    expect(asArray([1])).toEqual([1]);
    expect(asArray({})).toBeUndefined();
  });

  test('asString / asBool / asNumber are type guards', () => {
    expect(asString('x')).toBe('x');
    expect(asString(1)).toBeUndefined();
    expect(asBool(true)).toBe(true);
    expect(asBool('true')).toBeUndefined();
    expect(asNumber(3)).toBe(3);
    expect(asNumber('3')).toBeUndefined();
  });
});

describe('itemsOf', () => {
  test('extracts a list response .items array', () => {
    expect(itemsOf({ items: [{ a: 1 }, { b: 2 }] })).toEqual([{ a: 1 }, { b: 2 }]);
  });
  test('returns [] for missing/invalid shapes', () => {
    expect(itemsOf({})).toEqual([]);
    expect(itemsOf(null)).toEqual([]);
    expect(itemsOf({ items: 'nope' })).toEqual([]);
  });
});
