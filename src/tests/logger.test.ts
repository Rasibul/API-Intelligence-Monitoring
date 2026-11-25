import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyError, log } from '../app/utils/logger.js';

test('classification never copies arbitrary error names, codes, messages or extra fields', (context) => {
  const output: string[] = [];
  context.mock.method(console, 'error', (value: string) => output.push(value));
  const error = Object.assign(new Error('seeded-private-message'), {
    name: 'seeded-private-name',
    code: 'seeded-private-code',
    password: 'seeded-private-value',
  });
  log('error', 'request_failed', { errorKind: classifyError(error) });
  assert.equal(JSON.parse(output[0]!).errorKind, 'unknown');
  assert.ok(!output[0]!.includes('seeded-private'));
  assert.equal(
    classifyError(Object.assign(new Error(), { code: 'EACCES' })),
    'permission_denied',
  );
  assert.equal(classifyError(new SyntaxError('private')), 'syntax_error');
  assert.equal(classifyError('private'), 'unknown');
});
