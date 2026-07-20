# Security policy

## Supported versions

openbounce is pre-1.0 (`0.x`). Security fixes land on the **latest** released version; there are no
long-term support branches yet.

## Reporting a vulnerability

**Please report privately — do not open a public issue for a security problem.**

Use GitHub's **private vulnerability reporting**: on this repository, go to the **Security** tab →
**Report a vulnerability**. This opens a private advisory visible only to the maintainers.

In your report, please include:

- what the issue is and the impact you foresee,
- steps to reproduce (a minimal case is ideal),
- affected version(s), and
- any suggested fix or mitigation.

We'll acknowledge as soon as we reasonably can (this is a small, volunteer-maintained project), work with
you on a fix, and credit you in the advisory unless you'd prefer to stay anonymous. Please give us a
reasonable window to release a fix before any public disclosure.

## Scope notes

openbounce runs **locally** — it processes email addresses on infrastructure you control and persists
nothing by default. Two areas are especially in scope:

- **Untrusted network input.** All SMTP and DNS responses are treated as hostile input; a bug that lets a
  malicious mail server or resolver crash, hang, or corrupt a verification run is in scope.
- **Data handling.** Anything that causes addresses/PII to be logged, leaked, or persisted contrary to the
  local-first, store-nothing design is in scope.

Out of scope: issues that require a user to run openbounce against their own trusted infrastructure with
deliberately hostile local configuration, and general SMTP deliverability behavior (that's a feature of how
mail servers respond, not a vulnerability in openbounce).
