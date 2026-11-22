import { describe, expect, it } from 'vitest';
import { FORMAT_VERSION } from './index.js';

describe('core', () => {
  it('exposes graph format version', () => {
    expect(FORMAT_VERSION).toBe(1);
  });
});
