import { describe, expect, it } from 'vitest';
import { type EngineDeps, runPipeline } from '@/core/pipeline';
import { defaultData } from '@/data';
import type { SmtpProber } from '@/types';
import {
  type DnsFixture,
  fakeDns,
  fakeProber,
  fixedClock,
  fixedRng,
  recordingClock,
  sequenceProber,
  unavailableProber,
} from '../test-utils';

function deps(map: Record<string, DnsFixture>, prober: SmtpProber = unavailableProber): EngineDeps {
  return {
    data: defaultData,
    dns: fakeDns(map),
    prober,
    clock: fixedClock,
    rng: fixedRng,
  };
}

describe('runPipeline (offline, fake resolvers)', () => {
  it('rejects invalid syntax before any DNS', async () => {
    const r = await runPipeline('not-an-email', {}, deps({}));
    expect(r.status).toBe('invalid');
    expect(r.subStatus).toBe('invalid_syntax');
    expect(r.mx).toBeUndefined();
  });

  it('flags a domain with no MX/A as invalid', async () => {
    const r = await runPipeline('x@dead.example', {}, deps({ 'dead.example': { mx: [], a: [] } }));
    expect(r.status).toBe('invalid');
    expect(r.subStatus).toBe('no_mx');
  });

  it('treats an RFC 7505 null MX as no_mx and does NOT fall back to the A record', async () => {
    // `MX 0 .` (host → '') plus a website A record: still invalid/no_mx — the domain refuses mail.
    const r = await runPipeline(
      'x@no-mail.example',
      {},
      deps({ 'no-mail.example': { mx: [''], a: ['93.184.216.34'] } }),
    );
    expect(r.status).toBe('invalid');
    expect(r.subStatus).toBe('no_mx');
  });

  it('falls back to an AAAA record (implicit MX) when there is no MX and no A', async () => {
    const r = await runPipeline(
      'user@ipv6only.example',
      {},
      deps({ 'ipv6only.example': { mx: [], a: [], aaaa: ['2606:2800:220:1::'] } }),
    );
    expect(r.subStatus).toBe('smtp_unavailable'); // deliverable domain, mailbox unverifiable offline
    expect(r.checks.find((c) => c.name === 'mx')?.outcome).toBe('pass');
  });

  it('detects a disposable domain', async () => {
    const r = await runPipeline(
      'throwaway@mailinator.com',
      {},
      deps({ 'mailinator.com': { mx: ['mail.mailinator.com'] } }),
    );
    expect(r.disposable).toBe(true);
    expect(r.status).toBe('disposable');
  });

  it('detects role + free + provider; an accept-all provider outranks the role status', async () => {
    const r = await runPipeline(
      'info@gmail.com',
      {},
      deps({ 'gmail.com': { mx: ['gmail-smtp-in.l.google.com'] } }),
    );
    expect(r.free).toBe(true);
    expect(r.role).toBe(true); // the role / free flags are still surfaced…
    expect(r.provider).toBe('google');
    // …but the status is provider_unverifiable — and now *consistently* so, whether or not port 25 is
    // open. (Previously this returned `role` when port 25 was blocked but `provider_unverifiable` when
    // it was open; a role mailbox at Gmail is no more verifiable than any other, so we don't probe it.)
    expect(r.status).toBe('unknown');
    expect(r.subStatus).toBe('provider_unverifiable');
  });

  it('is honest (unknown/smtp_unavailable) for a normal deliverable mailbox without SMTP', async () => {
    const r = await runPipeline(
      'jane@acme-corp.example',
      {},
      deps({ 'acme-corp.example': { mx: ['mx.acme-corp.example'] } }),
    );
    expect(r.status).toBe('unknown');
    expect(r.subStatus).toBe('smtp_unavailable');
    expect(r.reachable).toBe('unknown');
    expect(r.provider).toBe('custom');
    expect(r.smtp.available).toBe(false);
  });

  it('surfaces a did-you-mean for a typo domain', async () => {
    const r = await runPipeline(
      'user@gmial.com',
      {},
      deps({ 'gmial.com': { mx: ['mx.gmial.com'] } }),
    );
    expect(r.didYouMean).toBe('user@gmail.com');
  });

  it('reports unknown on a DNS failure (never guesses)', async () => {
    const r = await runPipeline('x@flaky.example', {}, deps({ 'flaky.example': { error: true } }));
    expect(r.subStatus).toBe('dns_error');
    expect(r.reachable).toBe('unknown');
  });

  it('records a checks trace and a non-negative duration', async () => {
    const r = await runPipeline(
      'x@acme.example',
      {},
      deps({ 'acme.example': { mx: ['mx.acme.example'] } }),
    );
    expect(r.checks.find((c) => c.name === 'syntax')?.outcome).toBe('pass');
    expect(r.checks.find((c) => c.name === 'mx')?.outcome).toBe('pass');
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('skips SMTP when smtp:false', async () => {
    const r = await runPipeline(
      'x@acme.example',
      { smtp: false },
      deps({ 'acme.example': { mx: ['mx.acme.example'] } }),
    );
    expect(r.checks.find((c) => c.name === 'smtp')?.detail).toBe('disabled');
  });
});

describe('runPipeline — SMTP mailbox probe (Phase 3)', () => {
  const acme = { 'acme.example': { mx: ['mx.acme.example'] } };

  it('confirms a mailbox on a custom domain → valid/safe (and not catch-all)', async () => {
    const prober = fakeProber({
      replies: { 'jane@acme.example': { code: 250, accepted: true } },
      fallback: { code: 550, accepted: false }, // the random catch-all probe is rejected
    });
    const r = await runPipeline('jane@acme.example', {}, deps(acme, prober));
    expect(r.status).toBe('valid');
    expect(r.reachable).toBe('safe');
    expect(r.catchAll).toBe(false);
  });

  it('rejects a missing mailbox → invalid/mailbox_not_found', async () => {
    const prober = fakeProber({
      replies: { 'ghost@acme.example': { code: 550, accepted: false } },
    });
    const r = await runPipeline('ghost@acme.example', {}, deps(acme, prober));
    expect(r.status).toBe('invalid');
    expect(r.subStatus).toBe('mailbox_not_found');
  });

  it('detects a catch-all domain → catch_all/risky', async () => {
    const prober = fakeProber({ fallback: { code: 250, accepted: true } }); // every recipient accepted
    const r = await runPipeline('jane@acme.example', {}, deps(acme, prober));
    expect(r.status).toBe('catch_all');
    expect(r.catchAll).toBe(true);
  });

  it('skips the probe for an accept-all-prone provider → provider_unverifiable (no wasted RCPT)', async () => {
    // The verdict is provider_unverifiable whether or not we probe — so we must NOT probe Gmail: it's
    // uninformative and, on a bulk consumer list, serializes into one per-domain queue.
    let probeCalls = 0;
    const countingProber: SmtpProber = {
      preflight: () => Promise.resolve(true),
      probe: () => {
        probeCalls++;
        return Promise.resolve({ code: 250, accepted: true, outcome: 'accepted' });
      },
    };
    const r = await runPipeline(
      'jane@gmail.com',
      {},
      deps({ 'gmail.com': { mx: ['gmail-smtp-in.l.google.com'] } }, countingProber),
    );
    expect(r.status).toBe('unknown');
    expect(r.subStatus).toBe('provider_unverifiable');
    expect(probeCalls).toBe(0); // the win: no RCPT probe fired at Gmail
    expect(r.smtp.attempted).toBe(false);
    expect(r.smtp.available).toBe(true); // preflight still ran, so smtp.available stays honest
    expect(r.checks.find((c) => c.name === 'smtp')?.outcome).toBe('skip');
  });

  it('reports greylisting (4xx after retries) as unknown/greylisted', async () => {
    const r = await runPipeline(
      'jane@acme.example',
      {},
      deps(acme, fakeProber({ fallback: { code: 451, accepted: false } })),
    );
    expect(r.status).toBe('unknown');
    expect(r.subStatus).toBe('greylisted');
  });

  it('degrades to honest unknown when port 25 is unavailable', async () => {
    const r = await runPipeline(
      'jane@acme.example',
      {},
      deps(acme, fakeProber({ available: false })),
    );
    expect(r.subStatus).toBe('smtp_unavailable');
  });

  it('a pre-RCPT 5xx (RBL block) is inconclusive — never a confident mailbox rejection', async () => {
    const prober = fakeProber({
      replies: { 'jane@acme.example': { code: 554, accepted: false, outcome: 'inconclusive' } },
    });
    const r = await runPipeline('jane@acme.example', {}, deps(acme, prober));
    expect(r.status).not.toBe('invalid');
    expect(r.status).toBe('unknown');
  });

  it('does NOT emit a confident valid when the catch-all probe is inconclusive', async () => {
    const prober = fakeProber({
      replies: { 'jane@acme.example': { code: 250, accepted: true } },
      fallback: { code: 451, accepted: false }, // the random catch-all probe greylists → undetermined
    });
    const r = await runPipeline('jane@acme.example', {}, deps(acme, prober));
    expect(r.status).not.toBe('valid');
    expect(r.status).toBe('unknown');
  });

  it('populates smtp.attempted + code after a real probe', async () => {
    const prober = fakeProber({
      replies: { 'jane@acme.example': { code: 250, accepted: true } },
      fallback: { code: 550, accepted: false },
    });
    const r = await runPipeline('jane@acme.example', {}, deps(acme, prober));
    expect(r.smtp.attempted).toBe(true);
    expect(r.smtp.code).toBe(250);
  });

  it('recovers from greylisting when a retry is accepted (and backs off via the clock)', async () => {
    const clock = recordingClock();
    const r = await runPipeline(
      'jane@acme.example',
      { checkCatchAll: false },
      {
        data: defaultData,
        dns: fakeDns(acme),
        prober: sequenceProber([
          { code: 451, accepted: false },
          { code: 250, accepted: true },
        ]),
        clock,
        rng: fixedRng,
      },
    );
    expect(r.status).toBe('valid');
    expect(clock.sleeps).toHaveLength(1); // one backoff before the successful retry
  });
});
