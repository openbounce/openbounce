import { describe, expect, it } from 'vitest';
import { readReply, runRcptProbe, type SmtpTransport } from '@/core/smtp-dialog';

// A transport that replays a scripted server side and records everything the client sends.
function scripted(serverLines: string[]): { transport: SmtpTransport; sent: string[] } {
  const sent: string[] = [];
  let i = 0;
  const transport: SmtpTransport = {
    readLine: () =>
      i < serverLines.length
        ? Promise.resolve(serverLines[i++] as string)
        : Promise.reject(new Error('server closed the connection')),
    writeLine: (command) => {
      sent.push(command);
      return Promise.resolve();
    },
  };
  return { transport, sent };
}

const input = { email: 'jane@acme.example', heloHost: 'probe.example', fromAddress: '' };

describe('readReply', () => {
  it('parses a single-line reply', async () => {
    const { transport } = scripted(['220 mx.acme.example ESMTP']);
    expect(await readReply(transport)).toEqual({
      code: 220,
      lines: ['220 mx.acme.example ESMTP'],
    });
  });
  it('assembles a multiline reply and takes the code from the final line', async () => {
    const { transport } = scripted(['250-mx.acme.example', '250-PIPELINING', '250 SIZE 10240000']);
    const reply = await readReply(transport);
    expect(reply.code).toBe(250);
    expect(reply.lines).toHaveLength(3);
  });
});

describe('runRcptProbe', () => {
  it('accepts an existing mailbox (2xx on RCPT) and never sends DATA', async () => {
    const { transport, sent } = scripted([
      '220 mx.acme.example ESMTP',
      '250 hello',
      '250 sender ok',
      '250 recipient ok',
      '221 bye',
    ]);
    const r = await runRcptProbe(transport, input);
    expect(r).toMatchObject({ outcome: 'accepted', code: 250 });
    expect(sent).toEqual([
      'EHLO probe.example',
      'MAIL FROM:<>', // null sender
      'RCPT TO:<jane@acme.example>',
      'QUIT',
    ]);
    expect(sent).not.toContain('DATA');
    expect(sent.some((c) => c.startsWith('DATA'))).toBe(false);
  });

  it('rejects a missing mailbox (5xx on RCPT)', async () => {
    const { transport } = scripted([
      '220 mx ESMTP',
      '250 hello',
      '250 sender ok',
      '550 5.1.1 no such user',
      '221 bye',
    ]);
    const r = await runRcptProbe(transport, input);
    expect(r).toMatchObject({ outcome: 'rejected', code: 550 });
  });

  it('reports greylisting (4xx on RCPT) so the pipeline can retry', async () => {
    const { transport } = scripted([
      '220 mx ESMTP',
      '250 hello',
      '250 sender ok',
      '451 4.7.1 greylisted, try later',
    ]);
    const r = await runRcptProbe(transport, input);
    expect(r.outcome).toBe('greylisted');
    expect(r.code).toBe(451);
  });

  it('falls back to HELO when EHLO is refused', async () => {
    const { transport, sent } = scripted([
      '220 mx',
      '502 command not implemented', // EHLO refused
      '250 hello', // HELO ok
      '250 sender ok',
      '250 recipient ok',
      '221 bye',
    ]);
    const r = await runRcptProbe(transport, input);
    expect(r.outcome).toBe('accepted');
    expect(sent).toContain('HELO probe.example');
  });

  it('sends the configured MAIL FROM when one is given', async () => {
    const { transport, sent } = scripted([
      '220 mx',
      '250 hello',
      '250 sender ok',
      '250 recipient ok',
      '221 bye',
    ]);
    await runRcptProbe(transport, { ...input, fromAddress: 'probe@openbounce.example' });
    expect(sent).toContain('MAIL FROM:<probe@openbounce.example>');
  });

  it('is inconclusive when the greeting is a 5xx (e.g. RBL block), and never sends a command', async () => {
    const { transport, sent } = scripted(['554 mx no service — client blocked']);
    const r = await runRcptProbe(transport, input);
    expect(r.outcome).toBe('inconclusive'); // NOT a mailbox rejection
    expect(sent).toHaveLength(0); // never got as far as EHLO
  });

  it('treats a MAIL FROM policy 5xx as inconclusive, not a mailbox rejection', async () => {
    const { transport } = scripted(['220 mx', '250 hello', '550 5.7.1 sender policy']);
    expect((await runRcptProbe(transport, input)).outcome).toBe('inconclusive');
  });

  it('is inconclusive when both EHLO and HELO are refused', async () => {
    const { transport } = scripted(['220 mx', '502 no ehlo', '502 no helo']);
    expect((await runRcptProbe(transport, input)).outcome).toBe('inconclusive');
  });

  it('treats a 4xx greeting as greylisted (retryable)', async () => {
    const { transport } = scripted(['421 service not available, try later']);
    expect((await runRcptProbe(transport, input)).outcome).toBe('greylisted');
  });
});
