import { describe, expect, it } from 'vitest';
import { sha256 } from '../src/shared/sha256.js';

describe('sha256', () => {
  it('hashes the empty string', () => {
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('hashes the classic abc vector', () => {
    expect(sha256('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes a two-block message', () => {
    expect(sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('hashes the quick brown fox vector', () => {
    expect(sha256('The quick brown fox jumps over the lazy dog')).toBe(
      'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
    );
  });

  it('hashes one million a characters', () => {
    expect(sha256('a'.repeat(1000000))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });

  it('hashes multi-byte utf-8 content', () => {
    expect(sha256('héllo wörld 你好')).toBe(
      '09b790d7df0b8dcf74d7862c7a601b8b7bbe2ab02a7ae2c259e78f8db5b00998',
    );
    expect(sha256('你好')).toBe(
      '670d9743542cae3ea7ebe36af56bd53648b0a1126162e78d81a32934a711302e',
    );
    expect(sha256('你好')).not.toBe(sha256('你好！'));
  });

  it('hashes byte arrays', () => {
    const bytes = Uint8Array.from([0x61, 0x62, 0x63]);
    expect(sha256(bytes)).toBe(sha256('abc'));
  });
});
