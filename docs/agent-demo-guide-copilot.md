# Running the HushJot agent demo with GitHub Copilot

By the end, GitHub Copilot will be working on a project whose requirements, questions, plan approval, documentation and follow-up requests all live in a HushJot folder you can edit from your phone.

Copilot comes in two local forms, and both work:
- **Part A: VS Code agent mode.** Gets the protocol and the prompts from the server. It has no loop, so you drive it, or use Copilot CLI for unattended runs.
- **Part B: Copilot CLI (`copilot`).** Can run unattended. If you turn its sandbox on, it needs one setting so the server can read your OS secret store.

The **Copilot cloud coding agent doesn't work** with HushJot. It runs on GitHub's machines, which can't reach the secret store on your computer.

> **Not yet run end to end.** This guide is written from the VS Code and GitHub docs. On your first run, check each item off:
> - [ ] VS Code: `.vscode/mcp.json` starts the server, and `/hushjot.plan` appears in chat
> - [ ] VS Code: trusting the server in **Manage Tool Approval** stops the prompts
> - [ ] CLI: `copilot mcp add` registers the server, and `/mcp` shows it connected
> - [ ] CLI: with the sandbox on, `keychainAccess: true` lets the server start (or the MCP sandbox is off)
> - [ ] CLI: `--deny-tool 'shell(hushjot:*)'` blocks the command
> - [ ] CLI: `/every 15m` or the `pending --wait` loop picks up a ticked note
> - [ ] Linux: the sandbox setting that lets the server reach the keyring (B2)
> - [ ] Windows: the `cmd /c` registration starts the server in VS Code and in the CLI

## Shared setup

Follow **Steps 1 to 7 of the [Claude Code guide](agent-demo-guide.md)**. In Step 1, check for VS Code with GitHub Copilot, or `copilot --version`, instead of Claude Code.

At the end you should have:
- `hushjot` installed (from npm, or built from source);
- the key cached (`hushjot ls` works without asking for the passphrase);
- `Projects/demo-app` containing **Requirements**;
- `hushjot scope Projects` set, and `hushjot mcp enable` run.

Then create the code project, and install the skill (it comes with the CLI), which both forms read.

macOS / Linux:

```bash
mkdir -p ~/code/demo-app && cd ~/code/demo-app
mkdir -p ~/.copilot/skills
cp -r "$(npm root -g)/@hushjot/cli/skills/hushjot-project" ~/.copilot/skills/
```

Windows:

```powershell
New-Item -ItemType Directory -Force "$HOME\code\demo-app", "$HOME\.copilot\skills" | Out-Null
Set-Location "$HOME\code\demo-app"
Copy-Item -Recurse -Force "$(npm root -g)\@hushjot\cli\skills\hushjot-project" "$HOME\.copilot\skills\"
```

From a source build, copy `path/to/hushjot-cli/skills/hushjot-project` instead.

---

## Part A: VS Code agent mode

### A1. Register the server for this workspace

Create **`~/code/demo-app/.vscode/mcp.json`**:

```json
{
  "servers": {
    "hushjot": {
      "type": "stdio",
      "command": "hushjot",
      "args": ["mcp", "--agent", "Copilot", "--scope", "Projects/demo-app"]
    }
  }
}
```

- The top-level key is `servers`, not `mcpServers`.
- `--agent Copilot` makes the boxes read `Copilot may continue.`
- The folder name is personal, so don't commit this file: add `.vscode/mcp.json` to `.gitignore`.
- **Windows:** use `"command": "cmd"` and `"args": ["/c", "hushjot", "mcp", "--agent", "Copilot", "--scope", "Projects/demo-app"]`, because `hushjot` is a `.cmd` script.
- If VS Code can't find `hushjot`, use the full path from `which hushjot` (Windows: `where.exe hushjot`).

Open the folder in VS Code, open the file, and click **Start** above `hushjot`. Open Chat, switch to **Agent**, and click the tools icon. `hushjot` should list 11 tools.

### A2. Allow the HushJot tools, and keep the terminal away from your keys

1. Run **Chat: Manage Tool Approval** from the Command Palette, and tick **hushjot** to trust all its tools.
2. In your **user** settings (`settings.json`), make the terminal ask before `hushjot`, and before the macOS and Linux secret-store tools:

   ```json
   "chat.tools.terminal.autoApprove": {
     "/^hushjot\\b/": false,
     "/^security\\b/": false,
     "/^secret-tool\\b/": false
   }
   ```

   `false` makes VS Code ask; it doesn't block. To block outright, add a `PreToolUse` hook (a preview feature) that returns `"permissionDecision": "deny"` for those commands. On Windows there's no single command to cover: any PowerShell script can read Credential Manager.
3. Leave the server **unsandboxed** (don't set `sandboxEnabled` on it). A sandboxed server can't read your secret store.

### A3. Plan, answer and continue

1. In Agent chat, type **`/hushjot.plan`**. (Some VS Code versions show it as `/mcp.hushjot.plan`.)
2. Copilot reads the notes and writes **Questions 01**, ending with `- [ ] I have answered all questions. Copilot may continue.`
3. Answer on your phone. To test the autosave guard, run **`/hushjot.continue`** before ticking: Copilot should see the note is *waiting* and do nothing.
4. Tick the box and run `/hushjot.continue` again. `> Copilot picked this up · <time>` appears under your box.
5. Keep going with `/hushjot.continue` whenever you've ticked something: plan, approve, build, Inbox.

VS Code has no loop. To carry on while you're away, use the CLI (Part B) on the same project.

---

## Part B: Copilot CLI

### B1. Register the server

```bash
cd ~/code/demo-app
copilot mcp add hushjot -- hushjot mcp --agent Copilot --scope "Projects/demo-app"
```

On Windows, in PowerShell: `copilot mcp add hushjot '--' cmd /c hushjot mcp --agent Copilot --scope "Projects/demo-app"`.

This writes `~/.copilot/mcp-config.json`:

```json
{
  "mcpServers": {
    "hushjot": {
      "type": "local",
      "command": "hushjot",
      "args": ["mcp", "--agent", "Copilot", "--scope", "Projects/demo-app"],
      "env": {},
      "tools": ["*"]
    }
  }
}
```

- That file is global. For a per-project setup, put the same `mcpServers` block in `~/code/demo-app/.mcp.json`; Copilot reads it once you've trusted the folder.
- Copilot CLI passes MCP servers only `PATH`. Put any other variable you rely on, such as `HUSHJOT_HOME`, in `env`. On Windows, if the server starts in a terminal but not from Copilot, add `USERPROFILE`, `APPDATA` and `SystemRoot` there too.

### B2. Let the server read your secret store

Skip this step if you haven't turned on Copilot CLI's sandbox (`/sandbox`).

With the sandbox on, MCP servers run inside it by default. **On macOS**, Keychain access is off inside it. Either:

- **Allow Keychain access** in `~/.copilot/settings.json` (it can't be set from `/sandbox`):

  ```json
  { "sandbox": { "userPolicy": { "seatbelt": { "keychainAccess": true } } } }
  ```

- or turn off **Sandbox MCP servers** in `/sandbox`.

The first option also gives the agent's own shell commands Keychain access, which the deny rule in B3 then has to cover. `/mcp` shows "connected (sandboxed)" when the server runs inside the sandbox.

**On Linux and Windows**, the docs don't say whether a sandboxed server can reach the keyring or Credential Manager. If `hushjot` fails only with the sandbox on, turn off **Sandbox MCP servers** in `/sandbox`.

### B3. Start it with the right permissions

```bash
copilot \
  --allow-tool 'hushjot' \
  --allow-tool 'shell(npm:*)' --allow-tool 'shell(npx:*)' \
  --allow-tool 'shell(git init)' --allow-tool 'shell(git add:*)' --allow-tool 'shell(git commit:*)' \
  --deny-tool 'shell(hushjot:*)' --deny-tool 'shell(security:*)' --deny-tool 'shell(secret-tool:*)' \
  --allow-all-mcp-server-instructions
```

In PowerShell, put it on one line, or end each line with a backtick (`` ` ``) instead of `\`.

| Flag | Why |
|---|---|
| `--allow-tool 'hushjot'` | All HushJot tools without asking. |
| `--deny-tool 'shell(hushjot:*)'`, `'shell(security:*)'`, `'shell(secret-tool:*)'` | Stops the agent running the CLI (which could widen the scope), or reading the macOS Keychain or the Linux keyring. Deny always wins, even over `--yolo`. |
| `--allow-all-mcp-server-instructions` | Puts the server's protocol in the prompt up front, rather than only on request. |

### B4. Plan and continue

Copilot CLI doesn't support MCP prompts, so use words:

```
Plan the HushJot project: read the requirements and ask me questions in HushJot.
```

Then, after answering and ticking on your phone: `Continue the HushJot project.`

### B5. Let it run while you're away

**A. The built-in schedule (experimental).** Inside Copilot CLI:

```
/experimental on
/every 15m Continue the HushJot project.
```

The schedule lasts as long as the session.

**B. A shell loop.** Copilot doesn't start until you've ticked something.

macOS / Linux:

```bash
cd ~/code/demo-app
while hushjot pending --wait --folder "Projects/demo-app"; do
  copilot --continue -p "Continue the HushJot project." \
    --allow-tool 'hushjot' --allow-tool 'shell(npm:*)' --allow-tool 'shell(git commit:*)' \
    --deny-tool 'shell(hushjot:*)' --deny-tool 'shell(security:*)' --deny-tool 'shell(secret-tool:*)' \
    --allow-all-mcp-server-instructions --no-ask-user
done
```

Windows:

```powershell
Set-Location "$HOME\code\demo-app"
while ($true) {
  hushjot pending --wait --folder "Projects/demo-app"
  if ($LASTEXITCODE -ne 0) { break }
  copilot --continue -p "Continue the HushJot project." `
    --allow-tool 'hushjot' --allow-tool 'shell(npm:*)' --allow-tool 'shell(git commit:*)' `
    --deny-tool 'shell(hushjot:*)' `
    --allow-all-mcp-server-instructions --no-ask-user
}
```

Keep the computer awake while you're out: `caffeinate -i` on macOS, `systemd-inhibit` on Linux, `powercfg` on Windows (Step 10 of the [Claude Code guide](agent-demo-guide.md)).

`--continue` resumes the latest session, so Copilot keeps its context. Drop it for a fresh session each run; the notes carry the state either way.

Your phone side is the same as Steps 15 to 18 of the [Claude Code guide](agent-demo-guide.md), with "Copilot" in place of "Claude".

---

## Clean up afterwards (optional)

```bash
copilot mcp remove hushjot            # CLI
rm ~/code/demo-app/.vscode/mcp.json   # VS Code (Windows: Remove-Item)
hushjot mcp disable
hushjot logout
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| The server fails to start | Usually the secret store or the passphrase | Run `hushjot mcp --agent Copilot --scope "Projects/demo-app"` in a terminal: errors print there. |
| CLI: fails only with the sandbox on | The sandboxed server can't reach the secret store | Step B2. |
| "Cannot start the MCP server … passphrase" | The key isn't in your secret store | Run `hushjot ls` once. |
| VS Code: `hushjot` not found | VS Code doesn't see your shell's PATH | Use the absolute path from `which hushjot` (Windows: `where.exe hushjot`) in `mcp.json`. |
| Windows: `spawn hushjot ENOENT` | `hushjot.cmd` can't be started without a shell | Use `cmd /c` (A1, B1). |
| `/hushjot.plan` isn't offered | The server isn't started, or you're not in Agent mode | Start it from `mcp.json`, switch to Agent, and try `/mcp.hushjot.plan`. |
| Copilot acted on a note you hadn't ticked | It didn't get the protocol | CLI: add `--allow-all-mcp-server-instructions`. Either: install the skill, and say "call hushjot_protocol first". |
| Boxes say "Claude may continue." | `--agent Copilot` is missing | Add it to the server's args. Old Claude boxes still work. |

## Quick reference

```bash
# one-time: HushJot Steps 1–7 from agent-demo-guide.md (npm install -g @hushjot/cli, login, scope, mcp enable), then
cp -r "$(npm root -g)/@hushjot/cli/skills/hushjot-project" ~/.copilot/skills/

# VS Code: .vscode/mcp.json → servers.hushjot = hushjot mcp --agent Copilot --scope "Projects/demo-app"
#          (Windows: "command": "cmd", "args": ["/c", "hushjot", "mcp", …])
#          Manage Tool Approval → trust hushjot;  /hushjot.plan, then /hushjot.continue

# CLI
copilot mcp add hushjot -- hushjot mcp --agent Copilot --scope "Projects/demo-app"
copilot --allow-tool 'hushjot' --deny-tool 'shell(hushjot:*)' --deny-tool 'shell(security:*)' \
        --deny-tool 'shell(secret-tool:*)' --allow-all-mcp-server-instructions
#   Plan the HushJot project.   then   /experimental on, /every 15m Continue the HushJot project.
```
