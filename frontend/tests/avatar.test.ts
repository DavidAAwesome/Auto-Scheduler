import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AVATAR_MAX_BYTES, avatarFileError, initials } from '../src/services/avatarUpload.ts';

test('accepts JPG, PNG and WebP up to the documented 5 MB limit', () => {
  assert.equal(AVATAR_MAX_BYTES, 5 * 1024 * 1024);
  for (const type of ['image/jpeg', 'image/png', 'image/webp']) assert.equal(avatarFileError({ type, size: 1000 }), '');
  assert.equal(avatarFileError({ type: 'image/png', size: AVATAR_MAX_BYTES }), '');
});

test('rejects other formats, oversized and empty files with actionable messages', () => {
  for (const type of ['image/gif', 'image/svg+xml', 'image/heic', 'application/pdf', '']) {
    assert.match(avatarFileError({ type, size: 1000 }), /Choose a JPG, PNG, or WebP image/);
  }
  assert.equal(avatarFileError({ type: 'image/jpeg', size: 7.2 * 1024 * 1024 }), 'That image is 7.2 MB. Choose one of 5 MB or less.');
  assert.match(avatarFileError({ type: 'image/jpeg', size: 0 }), /empty/);
});

test('initials use the first and last name', () => {
  assert.equal(initials('Lan Phan'), 'LP');
  assert.equal(initials('  ada   b  lovelace '), 'AL');
  assert.equal(initials('lan'), 'L');
  assert.equal(initials(''), '?');
  assert.equal(initials(undefined), '?');
});
