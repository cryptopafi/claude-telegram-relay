import { describe, expect, test } from 'bun:test';
import { findWavDataOffset } from './voice-tts-stream';

function buildSimpleWavHeader(dataSize: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(24000 * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return header;
}

describe('findWavDataOffset', () => {
  test('returns standard 44-byte offset for PCM WAV', () => {
    const header = buildSimpleWavHeader(1024);
    expect(findWavDataOffset(header)).toBe(44);
  });

  test('returns -1 for incomplete header', () => {
    const partial = Buffer.from('RIFF', 'ascii');
    expect(findWavDataOffset(partial)).toBe(-1);
  });

  test('returns -1 for non-WAV payload', () => {
    const notWav = Buffer.from('this-is-not-a-wav-file');
    expect(findWavDataOffset(notWav)).toBe(-1);
  });
});
