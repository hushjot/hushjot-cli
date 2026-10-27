# Running the HushJot agent demo with Cursor

By the end, Cursor's agent will be working on a project whose requirements, questions, plan approval, documentation and follow-up requests all live in a HushJot folder you can edit from your phone.

The Cursor editor and the `agent` CLI share one MCP config, so one registration serves both:
- **In the editor**, you drive the agent from chat, and the server's prompts are available.
- **The CLI** can run unattended inside a shell loop.

> **Not yet run end to end.** This guide is written from Cursor's docs. On your first run, check each item off:
> - [ ] `.cursor/mcp.json` starts the server in the editor and in `agent`
> - [ ] The editor offers the `plan` and `continue` prompts
> - [ ] The model calls `hushjot_protocol` when asked (it may not get the server instructions)
> - [ ] CLI: `Mcp(hushjot:*)` runs the tools without asking, and the `Shell(hushjot)` deny blocks the CLI
> - [ ] The `pending --wait` loop with `agent -p` picks up a ticked note
> - [ ] Linux: the server reads the keyring when Cursor starts it
> - [ ] Windows: the `cmd /c` registration starts the server in the editor and in `agent`

## Part 1: One-time setup

### Step 1. Set up HushJot

Follow **Steps 1 to 7 of the [Claude Code guide](agent-demo-guide.md)**. In Step 1, check for Cursor, and for the CLI with `agent --version`, instead of Claude Code.

At the end you should have:
- `hushjot` installed (from npm, or built from source);
- the key cached (`hushjot ls` works without asking for the passphrase);
- `Projects/demo-app` containing **Requirements**;
- `hushjot scope Projects` set, and `hushjot mcp enable` run.

### Step 2. Register the server for this project

```bash
mkdir -p ~/code/demo-app/.cursor && cd ~/code/demo-app
```

On Windows: `New-Item -ItemType Directory -Force "$HOME\code\demo-app\.cursor" | Out-Null; Set-Location "$HOME\code\demo-app"`.

Create **`~/code/demo-app/.cursor/mcp.json`**:

```json
{
  "mcpServers": {
    "hushjot": {
      "type": "stdio",
      "command": "hushjot",
      "args": ["mcp", "--agent", "Cursor", "--scope", "Projects/demo-app"]
    }
  }
}
```

- `--agent Cursor` makes the boxes read `Cursor may continue.`
- The folder name is personal, so don't commit this file.
- **Windows:** use `"command": "cmd"` and `"args": ["/c", "hushjot", "mcp", "--agent", "Cursor", "--scope", "Projects/demo-app"]`, because `hushjot` is a `.cmd` script.
- If Cursor can't find `hushjot`, use the absolute path from `which hushjot` (Windows: `where.exe hushjot`).

Open the folder in Cursor and check **Settings → MCP**: `hushjot` should be enabled, with 11 tools.

### Step 3. Permissions

**In the editor**, turn on auto-run for the HushJot tools in the agent settings, and keep `hushjot`, `security` and `secret-tool` off any command allowlist.

**For the CLI**, create **`~/code/demo-app/.cursor/cli.json`**:

```json
{
  "permissions": {
    "allow": ["Mcp(hushjot:*)", "Shell(npm)", "Shell(npx)", "Shell(git)"],
    "deny": ["Shell(hushjot)", "Shell(security)", "Shell(secret-tool)"]
  }
}
```

| Rule | Why |
|---|---|
| `Mcp(hushjot:*)` | All HushJot tools without asking. |
| `Shell(npm)`, `Shell(git)` | Lets requests from your phone run. Narrow `Shell(git)` if you don't want `git push`. |
| deny `Shell(hushjot)` | Stops the agent running the CLI, where `hushjot scope clear` would show it your whole vault. |
| deny `Shell(security)`, `Shell(secret-tool)` | Stops it reading the HushJot key out of the macOS Keychain or the Linux keyring. On Windows there's no single command to deny: any PowerShell script can read Credential Manager. |

### Step 4. Install the skill and a rule

The skill comes with the CLI:

```bash
mkdir -p ~/.agents/skills
cp -r "$(npm root -g)/@hushjot/cli/skills/hushjot-project" ~/.agents/skills/
```

On Windows, the PowerShell version is in Step 11 of the [Claude Code guide](agent-demo-guide.md), with `.agents` in place of `.claude`. From a source build, copy `path/to/hushjot-cli/skills/hushjot-project` instead.

Add this line to **`~/code/demo-app/AGENTS.md`**, which Cursor reads:

```markdown
This project's requirements, questions, plan and docs live in HushJot. Follow the HushJot protocol (call hushjot_protocol if you don't have it). You are "Cursor" in the notes.
```

---

## Part 2: Running the demo

### Step 5. Start planning (editor)

Open the agent chat and use the server's **plan** prompt. If your Cursor version doesn't show MCP prompts, use words:

```
Call hushjot_protocol, then plan the HushJot project: read the requirements and ask me questions in HushJot.
```

Cursor should create **Questions 01**, ending with `- [ ] I have answered all questions. Cursor may continue.`, and stop.

### Step 6. Answer on your phone, and test the autosave guard

1. Answer the first question only. **Don't tick the box.**
2. Say `Continue the HushJot project.` (or use the **continue** prompt). **Expected:** it sees the note is *waiting* and does nothing.
3. Answer the rest, tick the box, and say it again. `> Cursor picked this up · <time>` appears under your box.

### Step 7. Let it run while you're away (CLI)

Cursor has no loop. Use a shell loop, which starts the CLI only when you've ticked something:

macOS / Linux:

```bash
cd ~/code/demo-app
while hushjot pending --wait --folder "Projects/demo-app"; do
  agent -p "Continue the HushJot project." --approve-mcps
done
```

Windows:

```powershell
Set-Location "$HOME\code\demo-app"
while ($true) {
  hushjot pending --wait --folder "Projects/demo-app"
  if ($LASTEXITCODE -ne 0) { break }
  agent -p "Continue the HushJot project." --approve-mcps
}
```

- Keep the computer awake while you're out: `caffeinate -i` on macOS, `systemd-inhibit` on Linux, `powercfg` on Windows (Step 10 of the [Claude Code guide](agent-demo-guide.md)).
- `--approve-mcps` approves the project's MCP servers without asking; the permissions in Step 3 still apply to each tool and command.
- Each run is a fresh session. That's fine: the plan, decisions and Inbox are in the notes.

Your phone side is the same as Steps 15 to 18 of the [Claude Code guide](agent-demo-guide.md), with "Cursor" in place of "Claude".

### Step 8. Clean up afterwards (optional)

```bash
rm ~/code/demo-app/.cursor/mcp.json ~/code/demo-app/.cursor/cli.json   # Windows: Remove-Item
hushjot mcp disable
hushjot logout
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| The server shows an error in Settings → MCP | It exited at startup | Run `hushjot mcp --agent Cursor --scope "Projects/demo-app"` in a terminal: errors print there. |
| `hushjot` not found | Cursor doesn't see your shell's PATH | Use the absolute path from `which hushjot` (Windows: `where.exe hushjot`). |
| Windows: `spawn hushjot ENOENT` | `hushjot.cmd` can't be started without a shell | Use `cmd /c` (Step 2). |
| "Cannot start the MCP server … passphrase" | The key isn't in your secret store | Run `hushjot ls` once. |
| The agent acted on a note you hadn't ticked | It didn't get the protocol | Ask it to call `hushjot_protocol` first, and check the skill and AGENTS.md line are in place. |
| `agent -p` stops at a prompt | A command isn't allowed | Add it to `allow` in `.cursor/cli.json`. |
| Boxes say "Claude may continue." | `--agent Cursor` is missing | Add it to the server's args. Old Claude boxes still work. |

## Quick reference

```bash
# one-time: HushJot Steps 1–7 from agent-demo-guide.md (npm install -g @hushjot/cli, login, scope, mcp enable), then
#   .cursor/mcp.json → hushjot mcp --agent Cursor --scope "Projects/demo-app"   (Windows: cmd /c hushjot …)
#   .cursor/cli.json → allow Mcp(hushjot:*), deny Shell(hushjot), Shell(security), Shell(secret-tool)
cp -r "$(npm root -g)/@hushjot/cli/skills/hushjot-project" ~/.agents/skills/

# editor: "Call hushjot_protocol, then plan the HushJot project."

# unattended (keep the computer awake; Windows: the PowerShell loop in Step 7)
while hushjot pending --wait --folder "Projects/demo-app"; do
  agent -p "Continue the HushJot project." --approve-mcps
done
```
