# Running the HushJot agent demo with xAI Grok Build

By the end, Grok Build will be working on a project whose requirements, questions, plan approval, documentation and follow-up requests all live in a HushJot folder you can edit from your phone.

**This is xAI's official Grok Build** (`grok`, docs at docs.x.ai/build), not the community `superagent-ai/grok-cli`. Both install a `grok` command and use `~/.grok`, so check which one you have before you start.

Of the agents here, Grok Build is closest to Claude Code: it has a `/loop`, the same permission-rule style, and it reads Claude Code's MCP config, skills and `CLAUDE.md`.

> **Not yet run end to end.** This guide is written from the Grok Build docs. On your first run, check each item off:
> - [ ] `grok mcp add` registers the server, and `/mcps` shows it connected
> - [ ] A registration Grok picked up from Claude Code (`grok inspect`) doesn't clash with this one
> - [ ] The model finds the HushJot tools (Grok may reach MCP tools through a search step)
> - [ ] The model calls `hushjot_protocol` when asked (it may not get the server instructions)
> - [ ] The `deny` rules block `hushjot` and `security`
> - [ ] `/loop 15m …` picks up a ticked note
> - [ ] Linux: the server reads the keyring when Grok starts it
> - [ ] Windows: Grok Build's native Windows build (in beta) starts the server with `cmd /c`

## Part 1: One-time setup

### Step 1. Set up HushJot

Follow **Steps 1 to 7 of the [Claude Code guide](agent-demo-guide.md)**. In Step 1, check for Grok Build instead of Claude Code:

```bash
grok --version       # macOS / Linux install: curl -fsSL https://x.ai/cli/install.sh | bash
```

On Windows, xAI offers a PowerShell installer (in beta), or you can run Grok Build inside WSL. Use the install command from docs.x.ai/build. Under WSL, install and sign in to `hushjot` inside WSL too, following the Linux steps: WSL can't see the Windows Credential Manager.

Sign in through the browser on first run, or set `XAI_API_KEY`.

At the end you should have:
- `hushjot` installed (from npm, or built from source);
- the key cached (`hushjot ls` works without asking for the passphrase);
- `Projects/demo-app` containing **Requirements**;
- `hushjot scope Projects` set, and `hushjot mcp enable` run.

### Step 2. Create the code project and register the server

```bash
mkdir -p ~/code/demo-app && cd ~/code/demo-app

grok mcp add --scope project hushjot -- hushjot mcp --agent Grok --scope "Projects/demo-app"
grok mcp list
```

On native Windows, in PowerShell: `grok mcp add --scope project hushjot '--' cmd /c hushjot mcp --agent Grok --scope "Projects/demo-app"`. The `cmd /c` is there because `hushjot` is a `.cmd` script; the quotes stop PowerShell swallowing the `--`.

- `--scope project` writes `.grok/config.toml` in this project. Grok's `--scope` comes before the `--`; HushJot's comes after it.
- `--agent Grok` makes the boxes read `Grok may continue.`
- The folder name is personal, so don't commit `.grok/config.toml`.

**Already set up for Claude Code?** Grok Build also reads servers from `~/.claude.json` and `.mcp.json`. If you registered `hushjot` for this project with `claude mcp add`, Grok may already see it, without `--agent Grok`. Run `grok inspect` to see what it loaded. The entry in `.grok/config.toml` takes precedence.

### Step 3. Permissions

Add to **`~/code/demo-app/.grok/config.toml`**:

```toml
[permission]
allow = [
  "mcp__hushjot__*",
  "Bash(npm *)",
  "Bash(npx *)",
  "Bash(git init)",
  "Bash(git add *)",
  "Bash(git commit *)",
  "Bash(git status)",
]
deny = [
  "Bash(hushjot *)",
  "Bash(security *)",
  "Bash(secret-tool *)",
]
```

| Rule | Why |
|---|---|
| `allow mcp__hushjot__*` | All HushJot tools without asking, so it can work while you're away. |
| `allow Bash(npm *)`, `git …` | Lets requests from your phone run without a prompt. `git push` is deliberately left out. |
| `deny Bash(hushjot *)` | Stops the agent running the CLI directly, where `hushjot scope clear` would show it your whole vault. |
| `deny Bash(security *)`, `Bash(secret-tool *)` | Stops it reading the HushJot key out of the macOS Keychain or the Linux keyring. On Windows there's no single command to deny: any PowerShell script can read Credential Manager. |

Deny beats ask, and ask beats allow. Deny rules are also checked against each part of a chained command.

### Step 4. Choose the permission mode: auto

```bash
cd ~/code/demo-app
grok
```

Inside Grok, type **`/auto`**. It lets Grok carry on with routine actions while your deny rules still apply.

| Mode | For this demo |
|---|---|
| ask (default) | Workable, but it stops for every action. |
| `acceptEdits` | A safer fallback. |
| `plan` | Don't: it can't write the Questions or Plan notes. |
| **`auto`** | **Use this.** |
| `bypassPermissions` / `--yolo` | Don't. |

To make auto the default, set `[ui] permission_mode = "auto"` in `~/.grok/config.toml`; it's ignored in project config.

Grok's sandbox is off by default. If you turn it on, check the server still starts: it needs your OS secret store and the network.

### Step 5. Install the skill

Grok Build reads skills from `~/.agents/skills` (and Claude Code's skill folders). The skill comes with the CLI:

```bash
mkdir -p ~/.agents/skills
cp -r "$(npm root -g)/@hushjot/cli/skills/hushjot-project" ~/.agents/skills/
```

On Windows, the PowerShell version is in Step 11 of the [Claude Code guide](agent-demo-guide.md), with `.agents` in place of `.claude`. From a source build, copy `path/to/hushjot-cli/skills/hushjot-project` instead.

It also reads `AGENTS.md` and `CLAUDE.md`. Add this line to `~/code/demo-app/AGENTS.md`:

```markdown
This project's requirements, questions, plan and docs live in HushJot. Follow the HushJot protocol (call hushjot_protocol if you don't have it). You are "Grok" in the notes.
```

---

## Part 2: Running the demo

### Step 6. Check the connection

Type `/mcps`. `hushjot` should be connected. Tools can take a moment to appear after Grok starts, so wait a few seconds before your first prompt.

### Step 7. Start planning

Grok Build doesn't document MCP prompts or server instructions, so ask it to load the protocol:

```
Call hushjot_protocol, then plan the HushJot project: read the requirements and ask me questions in HushJot.
```

Grok should create **Questions 01**, ending with `- [ ] I have answered all questions. Grok may continue.`, and stop.

### Step 8. Answer on your phone, and test the autosave guard

1. Answer the first question only. **Don't tick the box.**
2. Type `Continue the HushJot project.` **Expected:** Grok sees the note is *waiting* and does nothing.
3. Answer the rest, tick the box, and say it again. `> Grok picked this up · <time>` appears under your box.

### Step 9. Let it run while you're away

```
/loop 15m continue the HushJot project
```

- It runs straight away, then every 15 minutes. The minimum interval is one minute.
- `/tasks`, or Ctrl+G, shows and cancels it. Loops expire after 7 days and probably don't survive a restart of Grok.
- Keep the computer awake: `caffeinate -i` on macOS, `systemd-inhibit` on Linux, `powercfg` on Windows (Step 10 of the [Claude Code guide](agent-demo-guide.md)).

Your phone side is the same as Steps 15 to 18 of the [Claude Code guide](agent-demo-guide.md), with "Grok" in place of "Claude".

**Headless alternative.** If you'd rather not keep a session open:

```bash
while hushjot pending --wait --folder "Projects/demo-app"; do
  grok -c -p "Continue the HushJot project." --permission-mode auto --no-auto-update
done
```

Windows (PowerShell):

```powershell
while ($true) {
  hushjot pending --wait --folder "Projects/demo-app"
  if ($LASTEXITCODE -ne 0) { break }
  grok -c -p "Continue the HushJot project." --permission-mode auto --no-auto-update
}
```

### Step 10. Clean up afterwards (optional)

```bash
cd ~/code/demo-app && grok mcp remove hushjot
hushjot mcp disable
hushjot logout
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `/mcps` shows hushjot failed | The server exited at startup | Read `~/.grok/logs/mcp/hushjot.stderr.log`, or run `hushjot mcp --agent Grok --scope "Projects/demo-app"` in a terminal. `grok mcp doctor` checks the config. |
| "Cannot start the MCP server … passphrase" | The key isn't in your secret store | Run `hushjot ls` once. |
| Windows: `spawn hushjot ENOENT` | `hushjot.cmd` can't be started without a shell | Register it through `cmd /c` (Step 2). |
| Two `hushjot` servers, or boxes say "Claude" | Grok also loaded your Claude Code registration | `grok inspect`; remove one, or keep the `.grok/config.toml` entry with `--agent Grok`. |
| The first prompt says it has no HushJot tools | The server was still connecting | Wait a few seconds, then try again. |
| The agent acted on a note you hadn't ticked | It didn't get the protocol | Ask it to call `hushjot_protocol` first, and check the skill and AGENTS.md line are in place. |
| `grok` behaves differently from this guide | You have the community `grok-cli` | Install Grok Build from x.ai. |

## Quick reference

```bash
# one-time: HushJot Steps 1–7 from agent-demo-guide.md (npm install -g @hushjot/cli, login, scope, mcp enable), then
mkdir -p ~/code/demo-app && cd ~/code/demo-app
grok mcp add --scope project hushjot -- hushjot mcp --agent Grok --scope "Projects/demo-app"
#   Windows: … hushjot '--' cmd /c hushjot mcp …
#   .grok/config.toml [permission]: allow mcp__hushjot__*, deny Bash(hushjot *), Bash(security *), Bash(secret-tool *)
cp -r "$(npm root -g)/@hushjot/cli/skills/hushjot-project" ~/.agents/skills/
caffeinate -i &        # keep awake: macOS. Linux: systemd-inhibit; Windows: powercfg
grok

# in Grok
/auto
Call hushjot_protocol, then plan the HushJot project.
/loop 15m continue the HushJot project
```
