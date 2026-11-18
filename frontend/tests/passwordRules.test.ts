import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passwordProblem, unmetPasswordRules } from '../src/utils/passwordRules.ts';

const unmet = (password: string) => unmetPasswordRules(password).map(rule => rule.id);

test('a password meeting every rule is accepted', () => {
  assert.deepEqual(unmet('Plan@2026'), []);
  assert.equal(passwordProblem('Plan@2026'), null);
  assert.deepEqual(unmet('aB3$efgh'), [], 'exactly 8 characters is enough');
});

test('each missing rule is reported on its own', () => {
  assert.deepEqual(unmet('Pl@n2026'.slice(0, 7)), ['length']);
  assert.deepEqual(unmet('plan@2026'), ['upper']);
  assert.deepEqual(unmet('PLAN@2026'), ['lower']);
  assert.deepEqual(unmet('Plan@Plan'), ['number']);
  assert.deepEqual(unmet('Plan2026x'), ['special']);
  assert.deepEqual(unmet(''), ['length', 'upper', 'lower', 'number', 'special']);
});

test('spaces do not count as special characters, but punctuation and symbols do', () => {
  assert.deepEqual(unmet('Plan 2026'), ['special']);
  for (const symbol of ['!', '@', '#', '$', '%', '^', '&', '*', '_', '-', '.', '?', '~', '€'])
    assert.deepEqual(unmet(`Plan2026${symbol}`), [], symbol);
});

test('accented letters count as upper and lower case', () => {
  assert.deepEqual(unmet('Élan@2026é'), []);
});

test('the error sentence names what is missing', () => {
  assert.equal(passwordProblem('plan2026'), 'Password needs: one uppercase letter, one special character.');
});
