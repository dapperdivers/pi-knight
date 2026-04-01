# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.8.x   | ✅ Current         |
| < 0.8   | ❌ Not supported   |

## Reporting a Vulnerability

**Please do NOT report security vulnerabilities through public GitHub issues.**

Instead, report them via email to: **derek.mackley@hotmail.com**

Please include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

You should receive an initial response within **48 hours**. We will work with you to understand and address the issue before any public disclosure.

## Security Considerations

Round Table manages AI agents as Kubernetes pods. Key security areas:

- **Pod isolation** — Knights run with restricted SecurityContexts and NetworkPolicies
- **NATS authentication** — JetStream consumers use per-knight credentials
- **Secret management** — Secrets are injected via ExternalSecrets/envFrom, never stored in CRDs
- **RBAC** — Operator uses least-privilege ClusterRole; knights get namespace-scoped ServiceAccounts
- **Ephemeral missions** — Auto-cleanup prevents resource leaks and reduces attack surface

## Disclosure Policy

- We follow [responsible disclosure](https://en.wikipedia.org/wiki/Responsible_disclosure)
- Fixes are released as patch versions
- CVEs are filed when applicable
- Credit is given to reporters (unless anonymity is requested)
