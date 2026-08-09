import { test, expect, describe } from 'bun:test';

import { parseCpu, parseMemory } from './quantity';

describe('parseCpu', () => {
  test('bare values are cores', () => {
    expect(parseCpu('2')).toBe(2);
    expect(parseCpu('0.5')).toBe(0.5);
  });

  test('the suffixes metrics-server and the API actually emit', () => {
    expect(parseCpu('250m')).toBeCloseTo(0.25);
    expect(parseCpu('1500u')).toBeCloseTo(0.0015);
    expect(parseCpu('123456789n')).toBeCloseTo(0.123456789);
  });

  test('garbage parses as zero rather than NaN', () => {
    expect(parseCpu('')).toBe(0);
    expect(parseCpu('abc')).toBe(0);
  });
});

describe('parseMemory', () => {
  test('binary suffixes across the whole range', () => {
    expect(parseMemory('1Ki')).toBe(1024);
    expect(parseMemory('128Mi')).toBe(128 * 1024 ** 2);
    expect(parseMemory('1Gi')).toBe(1024 ** 3);
    expect(parseMemory('1Ti')).toBe(1024 ** 4);
    expect(parseMemory('1Pi')).toBe(1024 ** 5);
    expect(parseMemory('1Ei')).toBe(1024 ** 6);
  });

  test('decimal suffixes across the whole range', () => {
    expect(parseMemory('512k')).toBe(512e3);
    expect(parseMemory('512M')).toBe(512e6);
    expect(parseMemory('1G')).toBe(1e9);
    expect(parseMemory('1T')).toBe(1e12);
    expect(parseMemory('1P')).toBe(1e15);
    expect(parseMemory('1E')).toBe(1e18);
  });

  test('binary suffixes win over their decimal prefix', () => {
    // "Mi" also ends with "M"; matching the decimal one first would be 4.9% off.
    expect(parseMemory('1Mi')).not.toBe(parseMemory('1M'));
    expect(parseMemory('1Mi')).toBe(1024 ** 2);
  });

  test('milli is a legal memory suffix', () => {
    expect(parseMemory('400m')).toBeCloseTo(0.4);
  });

  test('a bare number is already bytes', () => {
    expect(parseMemory('2048')).toBe(2048);
    expect(parseMemory('')).toBe(0);
  });
});
