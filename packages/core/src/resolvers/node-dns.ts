// Real DNS resolver (impure adapter — allowed I/O; lives outside the pure core). Implements the
// DnsResolver seam using a c-ares Resolver with a bounded timeout, so a slow/blackholed nameserver
// can't hang validate() indefinitely.

import { promises as dns } from 'node:dns';
import type { DnsResolver, MxRecord } from '../types';

// "No such record" (the domain/record simply doesn't exist) → return empty, not an error. Everything
// else (SERVFAIL, timeout, refused) is a transient failure the pipeline reports as `unknown`.
const NOT_FOUND = new Set(['ENOTFOUND', 'ENODATA']);

function isNotFound(err: unknown): boolean {
  if (err === null || typeof err !== 'object' || !('code' in err)) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && NOT_FOUND.has(code);
}

export interface NodeDnsResolverOptions {
  /** Per-query timeout in ms — bounds a slow/blackholed nameserver. Default 8000. */
  readonly timeoutMs?: number;
  /** c-ares retry count. Default 2. */
  readonly tries?: number;
}

export class NodeDnsResolver implements DnsResolver {
  private readonly resolver: InstanceType<typeof dns.Resolver>;

  constructor(options: NodeDnsResolverOptions = {}) {
    this.resolver = new dns.Resolver({
      timeout: options.timeoutMs ?? 8000,
      tries: options.tries ?? 2,
    });
  }

  async resolveMx(domain: string): Promise<MxRecord[]> {
    try {
      const records = await this.resolver.resolveMx(domain);
      return (
        records
          .map((r) => ({ host: r.exchange.toLowerCase().replace(/\.$/, ''), priority: r.priority }))
          // Keep RFC 7505 "null MX" (`0 .`, host → '') so the pipeline can distinguish "explicitly
          // accepts no mail" from "no MX records" and skip the A/AAAA implicit-MX fallback for it.
          .sort((a, b) => a.priority - b.priority)
      );
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
  }

  async resolve(domain: string, type: 'A' | 'AAAA'): Promise<string[]> {
    try {
      return type === 'A'
        ? await this.resolver.resolve4(domain)
        : await this.resolver.resolve6(domain);
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
  }
}
