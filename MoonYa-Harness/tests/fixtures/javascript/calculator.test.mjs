import test from 'node:test';
import assert from 'node:assert/strict';
import { add } from './calculator.mjs';

test('adds two numbers', () => {
  assert.equal(add(20, 22), 42);
});
