/**
 * Boot-time OTP configuration: the env schema must fail loudly and specifically on a
 * half-configured Slide, refuse the test-only provider in production, and treat blank
 * MSG91_* values as unset (they used to fail min(10) and kill the process).
 *
 * env.ts exits the process on invalid config, so each case imports it in a child process.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const boot = (extra: Record<string, string>) => {
  const res = spawnSync(
    process.execPath,
    [
      tsx,
      '-e',
      "import('./src/config/env.ts').then((m) => console.log('BOOT_OK ' + m.env.OTP_PROVIDER))",
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        SystemRoot: process.env.SystemRoot ?? '',
        DATABASE_URL: 'postgresql://u:p@localhost/db',
        JWT_ACCESS_SECRET: 'a'.repeat(40),
        JWT_REFRESH_SECRET: 'b'.repeat(40),
        ...extra,
      },
    },
  );
  return {
    ok: res.stdout.includes('BOOT_OK'),
    out: `${res.stdout}${res.stderr}`,
    stdout: res.stdout,
  };
};

const SLIDE = {
  OTP_PROVIDER: 'slide',
  SLIDE_API_KEY: 'sk_live_abcdefghij',
  SLIDE_WIDGET_ID: '95710d09-6fd3-4932-82c7-79b14dd11ca0',
  SLIDE_CLIENT_TOKEN: 'tok_abcdefgh',
};

describe('OTP env validation', () => {
  it('defaults to msg91, and blank MSG91_* values are "unset", not a crash', () => {
    const r = boot({ MSG91_AUTH_KEY: '', MSG91_RETAILER_AUTH_KEY: '', MSG91_DRIVER_AUTH_KEY: '' });
    expect(r.ok, r.out).toBe(true);
    expect(r.stdout).toContain('BOOT_OK msg91');
  });

  it('slide boots with its three credentials', () => {
    const r = boot(SLIDE);
    expect(r.ok, r.out).toBe(true);
    expect(r.stdout).toContain('BOOT_OK slide');
  });

  it.each(['SLIDE_API_KEY', 'SLIDE_WIDGET_ID', 'SLIDE_CLIENT_TOKEN'])(
    'slide without %s fails and names it',
    (missing) => {
      const r = boot({ ...SLIDE, [missing]: '' });
      expect(r.ok).toBe(false);
      expect(r.out).toContain(`${missing} is required when OTP_PROVIDER=slide`);
    },
  );

  it('the fake provider is refused in production', () => {
    const r = boot({ OTP_PROVIDER: 'fake', NODE_ENV: 'production' });
    expect(r.ok).toBe(false);
    expect(r.out).toContain('cannot run in production');
  });
});
