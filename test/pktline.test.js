// Unit tests for the pkt-line reader, specifically the `residual` path:
// bytes pulled off the source past the flush-pkt boundary. This never
// happens in practice against a well-behaved upload-pack (it blocks after
// the advertisement, so we never over-read) -- but readAdvertisement must
// not lose or duplicate bytes if a source ever does hand us more in one
// chunk. This is the one correctness-critical branch that SSH/local-process
// testing can never exercise, since neither transport ever triggers it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAdvertisement, serviceAdvertisementPrefix } from '../src/pktline.js';

// A minimal advertisement: one ref line, no capabilities, then flush.
// "0032<40 hex zeros> refs/heads/main\n" + "0000"
function fakeAdvertisement() {
  const refLine = `${'0'.repeat(40)} refs/heads/main\n`;
  const len = (refLine.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(len), Buffer.from(refLine), Buffer.from('0000')]);
}

function asyncIterableOf(chunks) {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { done: true }),
      };
    },
  };
}

test('readAdvertisement stops at the flush-pkt and preserves extra bytes as residual', async () => {
  const adv = fakeAdvertisement();
  const extra = Buffer.from('EXTRA-PACK-BYTES');
  const source = asyncIterableOf([Buffer.concat([adv, extra])]);

  const { advertisement, residual } = await readAdvertisement(source);
  assert.ok(advertisement.equals(adv), 'advertisement should be exactly up to and including the flush-pkt');
  assert.ok(residual.equals(extra), 'bytes past the flush-pkt must be preserved, not dropped');
});

test('readAdvertisement handles a pkt-line length header split across chunk boundaries', async () => {
  const adv = fakeAdvertisement();
  // Split in the middle of the 4-byte hex length header itself.
  const splitPoint = 2;
  const source = asyncIterableOf([adv.slice(0, splitPoint), adv.slice(splitPoint)]);

  const { advertisement, residual } = await readAdvertisement(source);
  assert.ok(advertisement.equals(adv));
  assert.equal(residual.length, 0);
});

test('readAdvertisement handles the payload itself split across many small chunks', async () => {
  const adv = fakeAdvertisement();
  const chunks = [];
  for (let i = 0; i < adv.length; i++) chunks.push(adv.slice(i, i + 1)); // one byte at a time
  const source = asyncIterableOf(chunks);

  const { advertisement, residual } = await readAdvertisement(source);
  assert.ok(advertisement.equals(adv));
  assert.equal(residual.length, 0);
});

test('readAdvertisement throws a clear error if the stream ends with no flush-pkt', async () => {
  const adv = fakeAdvertisement();
  const withoutFlush = adv.slice(0, adv.length - 4); // valid pkt-line, but no terminating flush
  const source = asyncIterableOf([withoutFlush]);
  await assert.rejects(readAdvertisement(source), /no flush-pkt seen/);
});

test('serviceAdvertisementPrefix produces a valid, correctly-lengthed pkt-line + flush', () => {
  const prefix = serviceAdvertisementPrefix('git-upload-pack');
  const lenHeader = prefix.slice(0, 4).toString('ascii');
  const len = parseInt(lenHeader, 16);
  assert.equal(len, prefix.length - 4, 'declared pkt-line length should match actual line length (excluding the trailing flush)');
  assert.equal(prefix.slice(4, len).toString('utf8'), '# service=git-upload-pack\n');
  assert.equal(prefix.slice(len).toString('ascii'), '0000');
});
