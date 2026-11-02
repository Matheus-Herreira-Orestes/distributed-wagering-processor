import { describe, expect, test } from 'bun:test';
import {
  SqsConfigurationError,
  sqsConfigFromEnvironment,
} from '../../../../../src/messaging/infrastructure/sqs/sqs-config.js';

describe('SQS configuration', () => {
  test('uses a 30-second wager visibility timeout by default', () => {
    expect(sqsConfigFromEnvironment({}).wagerVisibilityTimeoutSeconds).toBe(30);
  });

  test('parses a valid configured wager visibility timeout', () => {
    expect(sqsConfigFromEnvironment({
      SQS_WAGER_VISIBILITY_TIMEOUT_SECONDS: '120',
    }).wagerVisibilityTimeoutSeconds).toBe(120);
  });

  for (const invalid of ['0', '-1', '1.5', 'abc', '43201']) {
    test(`rejects invalid wager visibility timeout ${invalid}`, () => {
      expect(() => sqsConfigFromEnvironment({
        SQS_WAGER_VISIBILITY_TIMEOUT_SECONDS: invalid,
      })).toThrow(SqsConfigurationError);
    });
  }
});
