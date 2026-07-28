# Security policy

`gap-tolerant-router` is an in-memory algorithm. It does not read files, open
network connections, or execute input as code.

## Supported versions

Security fixes are prepared for the latest published release on npm only.
Reports involving earlier releases are still welcome. If it is safe and
practical to do so, it helps to check whether the issue also reproduces on the
latest release, but that check is not a prerequisite for reporting.

## Reporting a vulnerability

Report privately when crafted input can cause unbounded resource use, a process
crash outside the documented validation behavior, mutation that affects a later
request, or a bypass of one-way traversal.

Please report privately rather than in a public issue. Do not put vulnerability
details in a public issue.

- Preferred: open a private report through GitHub private vulnerability
  reporting at
  <https://github.com/seoulpro/gap-tolerant-router/security/advisories/new>.
- If that form is unavailable, email
  [lim@limsumin.com](mailto:lim@limsumin.com).

Please include the affected version, the smallest network that demonstrates the
problem, the options used, the impact, and a proposed limit or mitigation if you
have one.

## Scope

Ordinary route-quality disagreements and missing domain policy are not security
issues; they belong in the public issue tracker. This package repairs geometric
connectivity — it does not determine legal access or provide a safety-certified
route.

The constructor rejects non-finite geometry and invalid numeric options before
building any spatial index, and a single segment that would require more than
1,000,000 index samples fails fast with a `RangeError`. It intentionally does
not impose a universal graph-size limit. Applications that accept untrusted or
very large graphs are responsible for bounding node and segment counts and for
enforcing their own runtime limits.
