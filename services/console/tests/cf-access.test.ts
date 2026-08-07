import { afterEach, describe, expect, it } from 'vitest';
import { cfAccessAudiences, cfAccessConfigured, identityFromCfPayload } from '../lib/cf-access';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('cfAccessAudiences / cfAccessConfigured', () => {
  it('is unconfigured when CF_ACCESS_AUD is unset', () => {
    delete process.env.CF_ACCESS_AUD;
    expect(cfAccessAudiences()).toEqual([]);
    expect(cfAccessConfigured()).toBe(false);
  });

  it('parses a single audience', () => {
    process.env.CF_ACCESS_AUD = 'aud-1';
    expect(cfAccessAudiences()).toEqual(['aud-1']);
    expect(cfAccessConfigured()).toBe(true);
  });

  it('parses and trims a comma-separated list', () => {
    process.env.CF_ACCESS_AUD = 'aud-1, aud-2 ,aud-3';
    expect(cfAccessAudiences()).toEqual(['aud-1', 'aud-2', 'aud-3']);
  });
});

describe('identityFromCfPayload', () => {
  it('resolves a human login from email + sub', () => {
    expect(identityFromCfPayload({ email: 'Matt@Example.com', sub: 'user-123' })).toEqual({
      sub: 'user-123',
      email: 'user@example.com',
    });
  });

  it('resolves a service token from common_name when email is absent', () => {
    expect(identityFromCfPayload({ common_name: 'quill-svc' })).toEqual({
      sub: 'quill-svc',
      email: 'quill-svc@service.cloudflareaccess',
    });
  });

  it('returns null when neither email/sub nor common_name are present', () => {
    expect(identityFromCfPayload({})).toBeNull();
  });
});
