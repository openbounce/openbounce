// NetSmtpProber against a local fake SMTP server on 127.0.0.1 — exercises the real socket transport +
// the RCPT dialog end-to-end (multiline buffering, read timeout, mid-dialog drop) deterministically and
// without needing outbound port 25.

import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { NetSmtpProber, UnavailableSmtpProber } from '@/resolvers/smtp';

let server: net.Server | undefined;
const openSockets = new Set<net.Socket>();

afterEach(
  () =>
    new Promise<void>((resolve) => {
      for (const socket of openSockets) socket.destroy();
      openSockets.clear();
      const s = server;
      server = undefined;
      if (!s) return resolve();
      s.close(() => resolve());
    }),
);

function startServer(onConnect: (socket: net.Socket) => void): Promise<number> {
  server = net.createServer((socket) => {
    openSockets.add(socket);
    socket.on('error', () => {}); // swallow client RSTs (from our timeouts) so they don't crash the test
    socket.on('close', () => openSockets.delete(socket));
    onConnect(socket);
  });
  return new Promise((resolve) => {
    server?.listen(0, '127.0.0.1', () => resolve((server?.address() as net.AddressInfo).port));
  });
}

/** Read CRLF-delimited command lines from a client socket. */
function onLines(socket: net.Socket, handle: (line: string) => void): void {
  socket.setEncoding('utf8');
  let buffer = '';
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      handle(line);
    }
  });
}

/** A well-behaved fake MX: accepts `existing@…` at RCPT, 550s everything else. */
function rcptServer(socket: net.Socket): void {
  socket.write('220 fake.mx ESMTP\r\n');
  onLines(socket, (line) => {
    if (/^(EHLO|HELO|MAIL FROM)/i.test(line)) socket.write('250 ok\r\n');
    else if (/^RCPT TO:<(.*)>/i.test(line)) {
      const addr = /^RCPT TO:<(.*)>/i.exec(line)?.[1] ?? '';
      socket.write(addr.startsWith('existing@') ? '250 ok\r\n' : '550 5.1.1 no such user\r\n');
    } else if (/^QUIT/i.test(line)) {
      socket.write('221 bye\r\n');
      socket.end();
    } else socket.write('250 ok\r\n');
  });
}

const input = (email: string) => ({
  mxHost: '127.0.0.1',
  email,
  heloHost: 'probe.test',
  fromAddress: '',
  timeoutMs: 2000,
});

describe('NetSmtpProber (live local socket)', () => {
  it('preflight is true when a server is listening', async () => {
    const port = await startServer(rcptServer);
    expect(await new NetSmtpProber({ port, preflightHost: '127.0.0.1' }).preflight(2000)).toBe(
      true,
    );
  });

  it('accepts an existing mailbox (RCPT 250) over a real socket', async () => {
    const port = await startServer(rcptServer);
    const r = await new NetSmtpProber({ port }).probe(input('existing@acme.example'));
    expect(r).toMatchObject({ code: 250, accepted: true, outcome: 'accepted' });
  });

  it('rejects a missing mailbox (RCPT 550)', async () => {
    const port = await startServer(rcptServer);
    const r = await new NetSmtpProber({ port }).probe(input('ghost@acme.example'));
    expect(r).toMatchObject({ code: 550, accepted: false, outcome: 'rejected' });
  });

  it('parses a multiline EHLO reply across the socket buffer', async () => {
    const port = await startServer((socket) => {
      socket.write('220 mx\r\n');
      onLines(socket, (line) => {
        if (/^EHLO/i.test(line))
          socket.write('250-mx greets you\r\n250-PIPELINING\r\n250 SIZE 100\r\n');
        else if (/^RCPT TO/i.test(line)) socket.write('250 ok\r\n');
        else socket.write('250 ok\r\n');
      });
    });
    const r = await new NetSmtpProber({ port }).probe(input('a@acme.example'));
    expect(r).toMatchObject({ accepted: true });
  });

  it('rejects (times out) when the server greets then goes silent', async () => {
    const port = await startServer((socket) => socket.write('220 mx\r\n')); // never answers EHLO
    await expect(
      new NetSmtpProber({ port }).probe({ ...input('a@acme.example'), timeoutMs: 150 }),
    ).rejects.toThrow();
  });

  it('rejects when the server drops the connection mid-dialog', async () => {
    const port = await startServer((socket) => {
      socket.write('220 mx\r\n');
      onLines(socket, () => socket.destroy()); // RST on the first command
    });
    await expect(new NetSmtpProber({ port }).probe(input('a@acme.example'))).rejects.toThrow();
  });

  it('preflight is false when nothing is listening', async () => {
    // Port 1 is privileged and (almost) never has a listener → connection refused.
    expect(await new NetSmtpProber({ port: 1, preflightHost: '127.0.0.1' }).preflight(1000)).toBe(
      false,
    );
  });
});

describe('UnavailableSmtpProber', () => {
  it('reports unavailable and rejects probing', async () => {
    const prober = new UnavailableSmtpProber();
    expect(await prober.preflight()).toBe(false);
    await expect(prober.probe()).rejects.toThrow();
  });
});
