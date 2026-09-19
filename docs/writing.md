# Local write and execution extension

These tools extend the upstream read-only design at the user's request. Existing
tokens retain their original permissions. Missing or unknown requested scopes
default to read-only permissions. Never edit token records to upgrade them.

When connecting ChatGPT, explicitly request these OAuth scopes in advanced settings:

```
workspace.read workspace.search git.read execution.read offline_access workspace.write workspace.execute
```

The pairing screen lists the requested permissions. Complete authorization in the
browser; do not claim deployment complete until the web conversation uses the tools.
Removing scopes from settings does not revoke previously issued tokens; unpair to
revoke existing access when requested.

## Tools

- `write_file(path, content, expected_sha256?)`: create UTF-8 files up to 1 MiB.
  Replacing existing files requires the SHA-256 of their full current UTF-8 content.
  Returns the resulting hash. Refuses binary files, hard-linked targets, sensitive
  paths, project control files and destinations outside the workspace.
- `apply_patch(path, edits: [{old_text,new_text}])`: exact text replacements in a
  single existing file, applied sequentially. Each old_text must match once only.
  All edits are validated before writing. This is not unified-diff syntax.
- `run_command(command, cwd='.', timeout_ms=30000)`: PowerShell on Windows, sh on
  Unix, with a 120-second maximum timeout and capped combined output. Returns exit
  status, timeout and truncation flags. Nonzero exit means the command failed.

Write tools require `workspace.write`; command execution requires
`workspace.execute`. Mutating tool annotations let ChatGPT present its normal
confirmation UI. They do not enforce per-command user approval on the server.

**Commands run with the host user's privileges, NOT in a sandbox.** The starting
directory is checked, but commands can access other files and the network, run
project scripts, and modify sensitive files. Stripping inherited secret environment
variables and redacting known token shapes does not make arbitrary output secret-safe.
Only enable execution for a trusted account and explicit user-requested tasks.
Do not start persistent background services through this synchronous command tool;
timeout termination is best-effort for process descendants.

File path checks are not protection against a concurrent malicious local process
swapping directories. Use an OS sandbox if the workspace itself is hostile.

Save generated images using the existing workflow in `docs/images.md`.
Preserve all local extension source changes, tests and documentation on updates.
