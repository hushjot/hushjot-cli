# Using the HushJot MCP server with other agents

`hushjot mcp` is a plain stdio MCP server. Its tools take only strings and numbers. Any coding agent that can launch a local MCP server can use it: no adapter, no cloud component.

The guides below are written from each vendor's documentation. **Only Claude Code has been run end to end, and only on macOS.** The Linux and Windows steps are written from the CLI's code and the vendors' docs. Each guide opens with a checklist of what still needs a first real run; tick it off as you go and turn anything that fails into a Troubleshooting row.

| Agent | Guide | Status |
|---|---|---|
| Claude Code | [agent-demo-guide.md](agent-demo-guide.md) | Tested |
| OpenAI Codex (CLI, IDE extension, app) | [agent-demo-guide-codex.md](agent-demo-guide-codex.md) | Written from docs |
| GitHub Copilot (VS Code agent mode, Copilot CLI) | [agent-demo-guide-copilot.md](agent-demo-guide-copilot.md) | Written from docs |
| Google Antigravity CLI and Gemini CLI | [agent-demo-guide-gemini.md](agent-demo-guide-gemini.md) | Written from docs |
| xAI Grok Build | [agent-demo-guide-grok.md](agent-demo-guide-grok.md) | Written from docs |
| Cursor (editor and `agent` CLI) | [agent-demo-guide-cursor.md](agent-demo-guide-cursor.md) | Written from docs |

## What differs between agents

The tools work everywhere. What differs is everything Claude Code does around them:

| Agent | Gets the protocol from the server | `plan` / `continue` prompts | Repeats on its own | Runs the MCP server in a sandbox |
|---|---|---|---|---|
| Claude Code | yes | `/mcp__hushjot__plan` | `/loop 15m …` | no |
| Codex | yes | no: use plain words | app Automations only | no |
| Copilot in VS Code | yes | `/hushjot.plan` | no | only if you opt in |
| Copilot CLI | on request | no: use plain words | `/every 15m …` (experimental) | **yes, by default, once its sandbox is on (no Keychain access on macOS)** |
| Antigravity CLI (`agy`) | not documented | not documented | no | not documented |
| Gemini CLI | yes | `/plan` | no | only with `-s` |
| Grok Build | not documented | not documented | `/loop 15m …` | off by default |
| Cursor | not documented | yes | no | not documented |

The HushJot side covers each gap:

- **Your agent's name in the notes.** `hushjot mcp --agent Codex` makes the boxes read `Codex may continue.` and the receipts `> Codex picked this up`. Boxes with any one-word name count, so a project planned under Claude can be continued under Codex, and your existing notes keep working.
- **The protocol for clients that drop it.** The server sends its working protocol when the agent connects. Agents that don't pass it on to the model can call the `hushjot_protocol` tool. The `hushjot_ls` and `hushjot_pending` tool descriptions tell the model to do that, and the [skill](../skills/hushjot-project/SKILL.md) says the same.
- **Plain words instead of prompts.** "Plan the HushJot project" and "Continue the HushJot project" do the same as the `plan` and `continue` prompts, because the protocol says what each means.
- **A loop for agents without one.** `hushjot pending --wait` blocks until a note is ready, then exits. Wrapped around the agent's headless mode, it starts the agent only when you've ticked something, and spends no model tokens in between:

  ```bash
  while hushjot pending --wait --folder "Projects/demo-app"; do
    codex exec resume --last "Continue the HushJot project."
  done
  ```

  In PowerShell on Windows:

  ```powershell
  while ($true) {
    hushjot pending --wait --folder "Projects/demo-app"
    if ($LASTEXITCODE -ne 0) { break }
    codex exec resume --last "Continue the HushJot project."
  }
  ```

  It checks every 2 minutes (`--every 30s` to `--every 1h`), rides out network drops and sleep, and exits non-zero if something needs you, such as being signed out. It runs as you, in your own terminal, so denying the agent the `hushjot` command still holds.

## The same in every guide

- **Part 1, Steps 1 to 7 of the [Claude Code guide](agent-demo-guide.md)** are the HushJot setup: install the CLI (`npm install -g @hushjot/cli`, or build from source), `hushjot login`, create the folder and Requirements note, `hushjot scope Projects`, `hushjot mcp enable`, and check with the MCP Inspector. Do those first.
- **Run `hushjot ls` once before starting the agent.** The server can't ask for your passphrase, so the key must already be in your OS secret store: the Keychain on macOS, Credential Manager on Windows, the keyring through `secret-tool` on Linux.
- **On Windows, start the server through `cmd /c`.** npm installs `hushjot` as a `.cmd` script, which an agent can't start without a shell. In a JSON config, that's `"command": "cmd", "args": ["/c", "hushjot", "mcp", …]`. In an `… mcp add` command typed into PowerShell, quote the separator as `'--'`.
- **Install `hushjot` on the same side as the agent.** An agent running inside WSL needs `hushjot` installed and signed in inside WSL, following the Linux steps. WSL can't see the Windows Credential Manager.
- **Deny the agent the `hushjot` command, and the secret-store tools.** With `hushjot` it could run `hushjot scope clear` and see your whole vault. With `security` (macOS) or `secret-tool` (Linux) it could read the key out of the store. Windows has no single command to deny, because any PowerShell script can read Credential Manager. Each guide shows that agent's syntax.
- **Allow everything you'll ask for from your phone.** A permission prompt at the terminal waits until you're back.
- **Keep the computer awake** while you're out: `caffeinate -i` on macOS, `systemd-inhibit` on Linux, `powercfg` on Windows (Step 10 of the Claude Code guide).

## Other MCP clients

These should work the same way, but haven't been tried. Register the server (on Windows, through `cmd /c`), deny `hushjot` and the secret-store tools to the agent's shell, and start with "Call hushjot_protocol, then plan the HushJot project".

| Client | Registration |
|---|---|
| opencode | `opencode.json`: `{"mcp":{"hushjot":{"type":"local","command":["hushjot","mcp","--agent","opencode","--scope","Projects/demo-app"]}}}` |
| Goose | `~/.config/goose/config.yaml`: `extensions: {hushjot: {type: stdio, cmd: hushjot, args: [mcp, --agent, Goose, --scope, Projects/demo-app], timeout: 300, enabled: true}}` |
| Cline | `cline_mcp_settings.json`: `{"mcpServers":{"hushjot":{"command":"hushjot","args":["mcp","--agent","Cline","--scope","Projects/demo-app"]}}}` |
| Windsurf (Devin Desktop) | `~/.config/devin/mcp_config.json`, the same `mcpServers` shape |
| Amp | `amp mcp add hushjot -- hushjot mcp --agent Amp --scope "Projects/demo-app"` |
| Kiro | `.kiro/settings/mcp.json`, the same `mcpServers` shape, with `"autoApprove": ["*"]` |
| Zed | `settings.json`: `"context_servers": {"hushjot": {"command": "hushjot", "args": [...]}}` |
| Factory Droid | `droid mcp add hushjot "hushjot mcp --agent Droid --scope Projects/demo-app"` |
| Claude Desktop | `claude_desktop_config.json`, `mcpServers`: in `~/Library/Application Support/Claude/` on macOS, `%APPDATA%\Claude\` on Windows. There's no Linux app. On macOS, use the absolute path from `which hushjot`, because the app doesn't get your shell's PATH. On Windows, use `cmd /c hushjot`. |

## What can't work

**Cloud agents can't run it:** the Copilot cloud coding agent, Codex cloud tasks, Google Jules and similar. They run on someone else's machine, with no access to your OS secret store, which is where the key that decrypts your notes lives. That's the design, not a gap to close.
