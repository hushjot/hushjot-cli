# Running the HushJot agent demo with Google's agents

By the end, a Google agent will be working on a project whose requirements, questions, plan approval, documentation and follow-up requests all live in a HushJot folder you can edit from your phone.

Google has two terminal agents, and this guide covers both:
- **Part A: Antigravity CLI (`agy`).** It replaces Gemini CLI for free-tier and Google One accounts.
- **Part B: Gemini CLI (`gemini`).** Still available with enterprise licences and paid Google Cloud API keys. It has the better MCP support of the two: it passes on the server's protocol and turns its prompts into slash commands.

Google Jules can't be used: it runs in a cloud VM that can't reach the secret store on your computer.

> **Not yet run end to end.** This guide is written from Google's docs. Antigravity's MCP docs say the least, so check it first. On your first run, check each item off:
> - [ ] agy: the config path below is the one `/mcp` uses (it differs between versions)
> - [ ] agy: the server starts under the default sandbox, and can read the secret store and reach Firestore
> - [ ] agy: `deny command(hushjot)` blocks the CLI
> - [ ] agy: the model calls `hushjot_protocol` when asked (it may not get the server instructions)
> - [ ] gemini: `gemini mcp add --trust` registers the server, and `/plan` appears
> - [ ] gemini: the policy file's deny rules block `hushjot` and `security`
> - [ ] Both: the `pending --wait` loop with `-p` picks up a ticked note
> - [ ] Linux: the keyring is reachable from the server each agent starts
> - [ ] Windows: the `cmd /c` registration starts the server, and the config paths below are right under `%USERPROFILE%`

## Shared setup

Follow **Steps 1 to 7 of the [Claude Code guide](agent-demo-guide.md)**. In Step 1, check for `agy --version` or `gemini --version` instead of Claude Code.

At the end you should have:
- `hushjot` installed (from npm, or built from source);
- the key cached (`hushjot ls` works without asking for the passphrase);
- `Projects/demo-app` containing **Requirements**;
- `hushjot scope Projects` set, and `hushjot mcp enable` run.

Then create the code project, and install the skill (it comes with the CLI) where both agents look.

macOS / Linux:

```bash
mkdir -p ~/code/demo-app && cd ~/code/demo-app
mkdir -p ~/.agents/skills
cp -r "$(npm root -g)/@hushjot/cli/skills/hushjot-project" ~/.agents/skills/
```

Windows:

```powershell
New-Item -ItemType Directory -Force "$HOME\code\demo-app", "$HOME\.agents\skills" | Out-Null
Set-Location "$HOME\code\demo-app"
Copy-Item -Recurse -Force "$(npm root -g)\@hushjot\cli\skills\hushjot-project" "$HOME\.agents\skills\"
```

From a source build, copy `path/to/hushjot-cli/skills/hushjot-project` instead.

On Windows, `~/.gemini/…` below means `%USERPROFILE%\.gemini\…`. And because `hushjot` is a `.cmd` script there, every registration starts it through `cmd /c`: `"command": "cmd"`, with `"/c", "hushjot"` at the front of `args`.

Both agents also read **`GEMINI.md`** in the project. Add:

```markdown
This project's requirements, questions, plan and docs live in HushJot. Follow the HushJot protocol (call hushjot_protocol if you don't have it). You are "Gemini" in the notes.
```

---

## Part A: Antigravity CLI (`agy`)

### A1. Register the server for this project

`agy` has no `mcp add` command. Create **`~/code/demo-app/.agents/mcp_config.json`**:

```json
{
  "mcpServers": {
    "hushjot": {
      "command": "hushjot",
      "args": ["mcp", "--agent", "Gemini", "--scope", "Projects/demo-app"]
    }
  }
}
```

On Windows: `"command": "cmd", "args": ["/c", "hushjot", "mcp", "--agent", "Gemini", "--scope", "Projects/demo-app"]`.

Start `agy` in the project and type `/mcp`. `hushjot` should be listed with 11 tools. If it isn't, `/mcp` shows which config file it read; depending on the version, the global one is under `~/.gemini/config/`, `~/.gemini/antigravity/` or `~/.gemini/antigravity-cli/`.

### A2. Permissions

Type `/permissions`, or edit **`~/.gemini/antigravity-cli/settings.json`**:

```json
{
  "permissions": {
    "allow": ["mcp(hushjot/*)", "command(npm)", "command(npx)", "command(git init)", "command(git add)", "command(git commit)"],
    "deny": ["command(hushjot)", "command(security)", "command(secret-tool)"]
  }
}
```

- Deny beats ask, and ask beats allow.
- `command(x)` matches on the first words of the command.
- Don't use `--dangerously-skip-permissions`.
- `security` is the macOS Keychain tool and `secret-tool` the Linux keyring's. On Windows there's no single command to deny: any PowerShell script can read Credential Manager.

**The sandbox.** By default, `agy` runs terminal commands in a sandbox with no network, limited to the project folder. Allow rules widen it. The docs don't say whether MCP servers run inside it. If `/mcp` shows `hushjot` failing while `hushjot mcp --agent Gemini --scope "Projects/demo-app"` works in your own terminal, the sandbox is the likely cause; record what fixed it in Troubleshooting.

### A3. Plan and continue

`agy` doesn't document MCP prompts or server instructions, so ask it to load the protocol first:

```
Call hushjot_protocol, then plan the HushJot project: read the requirements and ask me questions in HushJot.
```

Expected: **Questions 01** appears, ending with `- [ ] I have answered all questions. Gemini may continue.`

After answering and ticking on your phone:

```
Continue the HushJot project.
```

To test the autosave guard, say that once *before* ticking: it should see the note is waiting and do nothing.

### A4. Let it run while you're away

`agy` has no loop. Use a shell loop, which starts it only when you've ticked something:

macOS / Linux:

```bash
cd ~/code/demo-app
while hushjot pending --wait --folder "Projects/demo-app"; do
  agy -c -p "Continue the HushJot project." --print-timeout 30m
done
```

Windows:

```powershell
Set-Location "$HOME\code\demo-app"
while ($true) {
  hushjot pending --wait --folder "Projects/demo-app"
  if ($LASTEXITCODE -ne 0) { break }
  agy -c -p "Continue the HushJot project." --print-timeout 30m
}
```

- Keep the computer awake while you're out: `caffeinate -i` on macOS, `systemd-inhibit` on Linux, `powercfg` on Windows (Step 10 of the [Claude Code guide](agent-demo-guide.md)).
- `-c` continues the latest conversation. Drop it for a fresh one each time; the notes carry the state.
- `--print-timeout` raises the 5-minute limit on a headless run, so a build can finish.
- Headless runs can't answer prompts. Allow in A2 everything you'll ask for from your phone.

---

## Part B: Gemini CLI

### B1. Register the server

```bash
cd ~/code/demo-app
gemini mcp add --trust hushjot hushjot mcp --agent Gemini --scope "Projects/demo-app"
gemini mcp list
```

On Windows: `gemini mcp add --trust hushjot cmd /c hushjot mcp --agent Gemini --scope "Projects/demo-app"`.

- The default scope is the project, so this writes `.gemini/settings.json` in `~/code/demo-app`.
- `--trust` skips the confirmation for every HushJot tool.
- Gemini CLI removes variables whose names contain `KEY`, `TOKEN`, `SECRET` or similar from what MCP servers inherit. If you use `HUSHJOT_PASSPHRASE`, pass it explicitly with `-e`. The OS secret store needs nothing.
- If folder trust is on, trust `~/code/demo-app`: untrusted folders start no MCP servers.

### B2. Deny the shell route to your keys

Create **`~/.gemini/policies/hushjot.toml`** (Gemini CLI ignores project-level policy files):

```toml
[[rule]]
mcpName = "hushjot"
decision = "allow"
priority = 200

[[rule]]
toolName = "run_shell_command"
commandPrefix = "hushjot"
decision = "deny"
priority = 300
denyMessage = "Use the HushJot MCP tools; the CLI can widen the folder scope."

[[rule]]
toolName = "run_shell_command"
commandPrefix = "security"
decision = "deny"
priority = 300
denyMessage = "The macOS Keychain holds the HushJot key."

[[rule]]
toolName = "run_shell_command"
commandPrefix = "secret-tool"
decision = "deny"
priority = 300
denyMessage = "The Linux keyring holds the HushJot key."
```

### B3. Choose the approval mode

```bash
gemini --approval-mode auto_edit
```

| Mode | For this demo |
|---|---|
| `default` | Asks before edits and commands. |
| **`auto_edit`** | **Use this.** Accepts file edits; your policy rules decide the rest. |
| `plan` | Don't: it can't write the Questions or Plan notes. |
| `yolo` | Don't. |

Don't use the sandbox (`-s`) for this demo: Gemini CLI warns that MCP servers may fail inside it.

### B4. Plan and continue

Gemini CLI turns the server's prompts into slash commands:

```
/plan
```

After answering and ticking on your phone:

```
/continue
```

If those names clash with another server's prompts, use plain words: "Plan the HushJot project", "Continue the HushJot project".

### B5. Let it run while you're away

```bash
cd ~/code/demo-app
while hushjot pending --wait --folder "Projects/demo-app"; do
  gemini -r latest -p "Continue the HushJot project." --approval-mode auto_edit
done
```

On Windows, use the PowerShell loop from A4 with this `gemini` line in place of `agy`. Keep the computer awake either way.

`-r latest` resumes the latest session. Your phone side is the same as Steps 15 to 18 of the [Claude Code guide](agent-demo-guide.md), with "Gemini" in place of "Claude".

---

## Clean up afterwards (optional)

```bash
rm ~/code/demo-app/.agents/mcp_config.json                   # agy (Windows: Remove-Item)
cd ~/code/demo-app && gemini mcp remove hushjot              # gemini
rm ~/.gemini/policies/hushjot.toml
hushjot mcp disable
hushjot logout
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| The server fails to start | Usually the secret store or the passphrase | Run `hushjot mcp --agent Gemini --scope "Projects/demo-app"` in a terminal: errors print there. |
| agy: fails, but works in your terminal | Probably its sandbox | Check `/mcp` and `/permissions`; note what fixed it here. |
| "Cannot start the MCP server … passphrase" | The key isn't in your secret store | Run `hushjot ls` once. |
| Windows: `spawn hushjot ENOENT` | `hushjot.cmd` can't be started without a shell | Register it through `cmd /c` (see Shared setup). |
| gemini: no MCP servers at all | The folder isn't trusted | Trust `~/code/demo-app`. |
| The agent acted on a note you hadn't ticked | It didn't get the protocol | Ask it to call `hushjot_protocol` first, and check the skill and `GEMINI.md` line are in place. |
| A headless `agy -p` run stops part-way | The 5-minute print timeout | Raise `--print-timeout`. |
| Boxes say "Claude may continue." | `--agent Gemini` is missing | Add it to the server's args. Old Claude boxes still work. |

## Quick reference

```bash
# one-time: HushJot Steps 1–7 from agent-demo-guide.md (npm install -g @hushjot/cli, login, scope, mcp enable), then
cp -r "$(npm root -g)/@hushjot/cli/skills/hushjot-project" ~/.agents/skills/

# Windows: start the server as cmd /c hushjot mcp …, and use the PowerShell loop (A4)
# agy:    .agents/mcp_config.json → hushjot mcp --agent Gemini --scope "Projects/demo-app"
#         permissions: allow mcp(hushjot/*), deny command(hushjot), command(security), command(secret-tool)
#         "Call hushjot_protocol, then plan the HushJot project."

# gemini: gemini mcp add --trust hushjot hushjot mcp --agent Gemini --scope "Projects/demo-app"
#         ~/.gemini/policies/hushjot.toml: deny hushjot, security, secret-tool
#         gemini --approval-mode auto_edit, then /plan and /continue

# unattended
while hushjot pending --wait --folder "Projects/demo-app"; do
  agy -c -p "Continue the HushJot project." --print-timeout 30m     # or: gemini -r latest -p "…"
done
```
