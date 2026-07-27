# Security policy

`gap-tolerant-router` is an in-memory algorithm. It does not read files, open
network connections, or execute input as code.

## Reporting a vulnerability

Report privately when crafted input can cause unbounded resource use, a process
crash outside the documented validation behavior, mutation that affects a later
request, or a bypass of one-way traversal.

Use the repository's private vulnerability reporting on GitHub (**Security →
Report a vulnerability**). If that is unavailable, open a public issue that asks
for a private channel but **does not include the reproducing data**, and share
the details once a private channel is established.

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
