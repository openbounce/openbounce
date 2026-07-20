// The validation pipeline: pure orchestration over injected seams (no I/O, time, or randomness —
// enforced by the pure-core lint). Cheap/offline checks first, network last, degrade
// gracefully. The SMTP mailbox probe (step 5) runs only when a port-25 preflight succeeds.

import type {
  CheckName,
  CheckResult,
  Clock,
  DataProvider,
  DnsResolver,
  GreylistPolicy,
  MxRecord,
  ProbeOutcome,
  Provider,
  Result,
  Rng,
  SmtpProbeInput,
  SmtpProber,
  ValidateOptions,
} from '../types';
import { fingerprintProvider, UNRELIABLE_PROVIDERS } from './fingerprint';
import { score } from './score';
import { isValidSyntax, normalizeEmail, parseEmail } from './syntax';

export interface EngineDeps {
  readonly data: DataProvider;
  readonly dns: DnsResolver;
  readonly prober: SmtpProber;
  readonly clock: Clock;
  readonly rng: Rng;
}

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_HELO = 'localhost';
const DEFAULT_GREYLIST: GreylistPolicy = { retries: 1, delayMs: 5000 };

function check(name: CheckName, outcome: CheckResult['outcome'], detail?: string): CheckResult {
  return detail === undefined ? { name, outcome } : { name, outcome, detail };
}

interface ProbeSummary {
  readonly outcome: ProbeOutcome;
  readonly code: number;
  readonly message: string;
}

/**
 * One mailbox probe, trusting the prober's semantic `outcome` — a pre-RCPT 5xx / RBL block is
 * `inconclusive`, NOT a mailbox rejection. Retries only a `greylisted` (4xx) result, backing off via
 * the injected Clock. Resolves; never throws itself.
 */
async function probeMailbox(
  deps: EngineDeps,
  input: SmtpProbeInput,
  greylist: GreylistPolicy,
): Promise<ProbeSummary> {
  let attempt = 0;
  for (;;) {
    const res = await deps.prober.probe(input);
    if (res.outcome !== 'greylisted' || attempt >= greylist.retries) {
      return { outcome: res.outcome, code: res.code, message: res.message ?? '' };
    }
    attempt++;
    await deps.clock.sleep(greylist.delayMs, input.signal);
  }
}

function probeCheck(outcome: ProbeOutcome): CheckResult['outcome'] {
  return outcome === 'accepted' ? 'pass' : outcome === 'rejected' ? 'fail' : 'unknown';
}

/** A random, almost-certainly-nonexistent local-part for the catch-all probe (uses the injected Rng). */
function randomLocalPart(rng: Rng): string {
  return `ob-catchall-probe-${Math.floor(rng.next() * 1e12).toString(36)}`;
}

export async function runPipeline(
  email: string,
  options: ValidateOptions,
  deps: EngineDeps,
): Promise<Result> {
  const start = deps.clock.now();
  const address = normalizeEmail(email);
  const parsed = parseEmail(address);

  // 1. Syntax — short-circuit garbage before any network.
  if (parsed === null || !isValidSyntax(address)) {
    const verdict = score({
      syntaxOk: false,
      hasMx: false,
      disposable: false,
      role: false,
      smtpAvailable: false,
    });
    return {
      email: address,
      status: verdict.status,
      subStatus: verdict.subStatus,
      reachable: verdict.reachable,
      confidence: verdict.confidence,
      free: false,
      role: false,
      disposable: false,
      smtp: { attempted: false, available: false },
      checks: [check('syntax', 'fail')],
      durationMs: Math.max(0, deps.clock.now() - start),
    };
  }
  const { local, domain } = parsed;
  const checks: CheckResult[] = [check('syntax', 'pass')];

  // 2. Typo / did-you-mean (offline).
  const didYouMean = deps.data.suggest(address);
  checks.push(
    didYouMean === undefined
      ? check('typo', 'pass')
      : check('typo', 'fail', `did you mean ${didYouMean}?`),
  );

  // 3. Offline classification.
  const disposable = deps.data.isDisposable(domain);
  const free = deps.data.isFreeProvider(domain);
  const role = deps.data.isRoleAccount(local);
  checks.push(check('disposable', disposable ? 'fail' : 'pass'));
  checks.push(check('role', role ? 'fail' : 'pass'));
  checks.push(free ? check('free', 'pass', 'free/consumer provider') : check('free', 'pass'));

  // 4. DNS / MX (+ provider fingerprint).
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let hasMx: boolean | undefined;
  let mx: MxRecord[] | undefined;
  let provider: Provider | undefined;
  try {
    const records = await deps.dns.resolveMx(domain);
    const mxHosts = records.filter((r) => r.host.length > 0);
    if (mxHosts.length > 0) {
      mx = mxHosts;
      hasMx = true;
      provider = fingerprintProvider(mxHosts.map((r) => r.host));
      checks.push(check('mx', 'pass', `${mxHosts.length} record(s)`));
    } else if (records.length > 0) {
      // RFC 7505 "null MX" (`0 .`): the domain explicitly accepts no mail — do NOT fall back to A/AAAA.
      hasMx = false;
      checks.push(check('mx', 'fail', 'null MX (RFC 7505) — domain accepts no mail'));
    } else {
      // No MX at all → RFC 5321 implicit MX: deliverable iff the domain has an A or AAAA address.
      const a = await deps.dns.resolve(domain, 'A');
      const addrs = a.length > 0 ? a : await deps.dns.resolve(domain, 'AAAA');
      hasMx = addrs.length > 0;
      checks.push(
        check(
          'mx',
          hasMx ? 'pass' : 'fail',
          hasMx ? 'implicit MX (A/AAAA record)' : 'no MX / A / AAAA record',
        ),
      );
    }
  } catch {
    hasMx = undefined;
    checks.push(check('mx', 'unknown', 'DNS lookup failed'));
  }

  // 5. SMTP mailbox probe — gated on a port-25 preflight; always degrade to `unknown`, never throw.
  const unreliableProvider = provider !== undefined && UNRELIABLE_PROVIDERS.has(provider);
  let smtpAvailable = false;
  let smtpAttempted = false;
  let smtpCode: number | undefined;
  let smtpMessage: string | undefined;
  let smtpAccepted: boolean | undefined;
  let catchAll: boolean | undefined;
  let greylisted = false;
  if (options.smtp === false) {
    checks.push(check('smtp', 'skip', 'disabled'));
  } else if (hasMx === true) {
    try {
      smtpAvailable = await deps.prober.preflight(timeoutMs);
    } catch {
      smtpAvailable = false; // a failing preflight degrades to "unavailable", never throws
    }
    if (!smtpAvailable) {
      checks.push(check('smtp', 'skip', 'port 25 unavailable'));
    } else if (unreliableProvider) {
      // Accept-all-prone provider (Gmail/M365/Yahoo): a mailbox probe can't confirm anything here (they
      // `250` every address) and would only hammer their servers — and on a bulk consumer list, all
      // those same-domain probes serialize into one queue. Skip it; `score` already resolves these to
      // `provider_unverifiable`. (We still preflight above so `smtp.available` stays honest.)
      checks.push(check('smtp', 'skip', 'provider accepts all recipients — probe uninformative'));
    } else {
      // Top-priority MX host, or the domain itself for an implicit-MX (A/AAAA) domain.
      const mxHost = mx?.[0]?.host ?? domain;
      const base = {
        mxHost,
        heloHost: options.heloHost ?? DEFAULT_HELO,
        fromAddress: options.fromAddress ?? '',
        timeoutMs,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      };
      const greylist = options.greylist ?? DEFAULT_GREYLIST;
      try {
        smtpAttempted = true;
        const main = await probeMailbox(deps, { ...base, email: address }, greylist);
        smtpCode = main.code;
        smtpMessage = main.message;
        smtpAccepted =
          main.outcome === 'accepted' ? true : main.outcome === 'rejected' ? false : undefined;
        greylisted = main.outcome === 'greylisted';
        checks.push(check('smtp', probeCheck(main.outcome), `RCPT ${main.outcome}`));

        // Catch-all: only meaningful once the real mailbox was accepted on a provider we can trust (big
        // providers are already `provider_unverifiable`). Only a *definitive rejection* of a random
        // address proves the domain isn't catch-all → the acceptance is real. Any other outcome
        // (accepted / greylisted / inconclusive / errored) means we can't confirm the acceptance, so we
        // drop it to `unknown` rather than risk a confident false `valid`.
        if (smtpAccepted === true && !unreliableProvider && options.checkCatchAll !== false) {
          const probeAddress = `${randomLocalPart(deps.rng)}@${domain}`;
          let caOutcome: ProbeOutcome;
          try {
            caOutcome = (await probeMailbox(deps, { ...base, email: probeAddress }, greylist))
              .outcome;
          } catch {
            caOutcome = 'inconclusive';
          }
          if (caOutcome === 'rejected') {
            catchAll = false;
            checks.push(check('catch_all', 'pass', 'a distinct address was rejected'));
          } else if (caOutcome === 'accepted') {
            catchAll = true;
            checks.push(check('catch_all', 'fail', 'accepts all recipients'));
          } else {
            smtpAccepted = undefined; // can't rule out catch-all → don't claim a confident valid
            checks.push(check('catch_all', 'unknown', 'catch-all probe inconclusive'));
          }
        }
      } catch {
        // A mid-dialog failure (dropped connection, unparseable reply) → leave the verdict unknown.
        checks.push(check('smtp', 'unknown', 'probe error'));
      }
    }
  }

  // 6. Score + assemble (omit absent optionals — exactOptionalPropertyTypes).
  const verdict = score({
    syntaxOk: true,
    hasMx,
    disposable,
    role,
    smtpAvailable,
    smtpAccepted,
    catchAll,
    greylisted,
    unreliableProvider,
  });
  return {
    email: address,
    status: verdict.status,
    subStatus: verdict.subStatus,
    reachable: verdict.reachable,
    confidence: verdict.confidence,
    free,
    role,
    disposable,
    smtp: {
      attempted: smtpAttempted,
      available: smtpAvailable,
      ...(smtpCode !== undefined ? { code: smtpCode } : {}),
      ...(smtpMessage !== undefined && smtpMessage.length > 0 ? { message: smtpMessage } : {}),
    },
    checks,
    durationMs: Math.max(0, deps.clock.now() - start),
    ...(provider !== undefined ? { provider } : {}),
    ...(didYouMean !== undefined ? { didYouMean } : {}),
    ...(mx !== undefined ? { mx } : {}),
    ...(catchAll !== undefined ? { catchAll } : {}),
  };
}
