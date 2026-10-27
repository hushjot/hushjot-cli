# Security policy

## Reporting a vulnerability

Please do not open a public issue. Report it privately, either:

- through GitHub: **Security → Report a vulnerability** on this repository, or
- by email to support@hushjot.com, with "Security" in the subject.

Include what you found, how to reproduce it, and what an attacker could do
with it. You will get a reply within a few days.

## Scope

In scope: this CLI and its MCP server, including folder scoping, the
read-only mode, and how secrets are kept in the OS keychain. The encryption
format and the Firestore rules belong to
[the app](https://github.com/hushjot/hushjot); report those there.

Out of scope:

- `DEFAULT_API_KEY` in `src/config.ts`. It is the Firebase web key, public
  by design: it names the project and grants nothing. Access is decided by
  the app's `firestore.rules`.
- an agent that also has a shell as your user reaching the keychain. The
  scope keeps an agent on task but is not a sandbox, and the README says so.
