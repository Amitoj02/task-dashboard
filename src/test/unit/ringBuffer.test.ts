/**
 * Unit tests for {@link RingBuffer}: the byte-bounded output tail.
 *
 * Verifies eviction order, the oversized-chunk fast path, snapshot semantics,
 * clearing, and the running size accounting.
 *
 * @remarks Host-free unit test (mocha + tsx, no `vscode`).
 */

import assert from 'node:assert/strict';
import { RingBuffer } from '../../util/RingBuffer';

describe('RingBuffer', () => {
  it('retains data below the cap untouched', () => {
    const rb = new RingBuffer(100);
    rb.append(Buffer.from('hello'));
    rb.append(Buffer.from(' world'));

    assert.equal(rb.length, 11);
    assert.equal(rb.toBuffer().toString('utf8'), 'hello world');
  });

  it('trims minimally from the oldest chunk to reach the cap exactly', () => {
    const rb = new RingBuffer(10);
    rb.append(Buffer.from('AAAA')); // 4
    rb.append(Buffer.from('BBBB')); // 8
    rb.append(Buffer.from('CCCC')); // 12 -> over by 2; shed 2 from the front of 'AAAA'

    // Eviction sheds exactly the overflow: 'AA' is dropped, leaving 10 bytes.
    assert.equal(rb.length, 10);
    assert.equal(rb.toBuffer().toString('utf8'), 'AABBBBCCCC');
  });

  it('drops whole oldest chunks when the overflow exceeds them', () => {
    const rb = new RingBuffer(6);
    rb.append(Buffer.from('AA')); // 2
    rb.append(Buffer.from('BB')); // 4
    rb.append(Buffer.from('CCCCCC')); // 10 -> over by 4; drops 'AA' (2) then 'BB' (2)

    assert.equal(rb.length, 6);
    assert.equal(rb.toBuffer().toString('utf8'), 'CCCCCC');
  });

  it('trims the front of the oldest surviving chunk to fit exactly', () => {
    const rb = new RingBuffer(6);
    rb.append(Buffer.from('AAAA')); // 4
    rb.append(Buffer.from('BBBB')); // 8 -> over by 2; trim 2 from the front of 'AAAA'

    assert.equal(rb.length, 6);
    assert.equal(rb.toBuffer().toString('utf8'), 'AABBBB');
  });

  it('keeps only the tail of a single oversized chunk', () => {
    const rb = new RingBuffer(4);
    rb.append(Buffer.from('0123456789'));

    assert.equal(rb.length, 4);
    assert.equal(rb.toBuffer().toString('utf8'), '6789');
  });

  it('replaces prior content when an oversized chunk arrives', () => {
    const rb = new RingBuffer(4);
    rb.append(Buffer.from('xy'));
    rb.append(Buffer.from('ABCDEFGH')); // oversized -> drops 'xy', keeps tail

    assert.equal(rb.length, 4);
    assert.equal(rb.toBuffer().toString('utf8'), 'EFGH');
  });

  it('ignores empty appends', () => {
    const rb = new RingBuffer(8);
    rb.append(Buffer.alloc(0));
    assert.equal(rb.length, 0);
    assert.equal(rb.toBuffer().length, 0);
  });

  it('snapshot is a detached copy that does not alias internal state', () => {
    const rb = new RingBuffer(16);
    rb.append(Buffer.from('abc'));

    const snap = rb.toBuffer();
    snap[0] = 0x5a; // 'Z' — mutating the snapshot must not affect the ring

    assert.equal(rb.toBuffer().toString('utf8'), 'abc');
  });

  it('clear() drops everything and resets size', () => {
    const rb = new RingBuffer(16);
    rb.append(Buffer.from('something'));
    rb.clear();

    assert.equal(rb.length, 0);
    assert.equal(rb.toBuffer().length, 0);

    // Still usable after clearing.
    rb.append(Buffer.from('new'));
    assert.equal(rb.toBuffer().toString('utf8'), 'new');
  });

  it('clamps a sub-1 capacity up to 1 byte', () => {
    const rb = new RingBuffer(0);
    rb.append(Buffer.from('AB'));
    assert.equal(rb.length, 1);
    assert.equal(rb.toBuffer().toString('utf8'), 'B');
  });

  it('reports an empty buffer when nothing has been appended', () => {
    const rb = new RingBuffer(32);
    assert.equal(rb.length, 0);
    assert.equal(rb.toBuffer().length, 0);
  });
});
