# Running the HushJot agent demo with OpenAI Codex

By the end, Codex will be working on a project whose requirements, questions, plan approval, documentation and follow-up requests all live in a HushJot folder you can edit from your phone.

This guide covers the Codex CLI. The Codex IDE extension and the Codex app read the same `~/.codex/config.toml`, so the server you register here shows up in them as well.

> **Not yet run end to end.** This guide is written from the Codex docs. On your first run, check each item off:
> - [ ] `codex mcp add` registers the server, and `/mcp` shows it with 11 tools
> - [ ] The server starts within `startup_timeout_sec` (secret-store read plus first pull)
> - [ ] `default_tools_approval_mode = "approve"` runs the HushJot tools without asking
> - [ ] The `forbidden` rules block `hushjot` and `security` in the shell
> - [ ] The model follows the protocol from the server instructions without calling `hushjot_protocol`
> - [ ] `codex exec resume --last` inside the `pending --wait` loop picks up a ticked note
> - [ ] `codex exec` uses `sandbox_mode` from `config.toml` (if it stays read-only, add `--sandbox workspace-write`)
> - [ ] Linux: the server reads the keyring when Codex starts it
> - [ ] Windows: the `cmd /c` registration starts the server, and Codex passes it enough of the environment (see Troubleshooting)

## How it differs from Claude Code

| | Claude Code | Codex |
|---|---|---|
| Register | `claude mcp add` | `codex mcp add` |
| Protocol | server instructions | server instructions (Codex reads them) |
| Start planning | `/mcp__hushjot__plan` | plain words: Codex doesn't support MCP prompts |
| Unattended | `/loop 15m …` | a shell loop around `codex exec`, or an app Automation |
| Permissions | `.claude/settings.local.json` | `config.toml` plus `~/.codex/rules/*.rules` |
| Skill folder | `~/.claude/skills/` | `~/.agents/skills/` |

The MCP server runs **outside** Codex's sandbox (Codex starts it directly), so it can read your OS secret store and reach Firestore whatever sandbox mode you choose.

**Windows:** Codex runs natively in PowerShell, or inside WSL. Install `hushjot` on the same side as Codex. Inside WSL, that means following the Linux steps there, including signing in, because WSL can't see the Windows Credential Manager.

---

## Part 1: One-time setup

### Step 1. Set up HushJot

Follow **Steps 1 to 7 of the [Claude Code guide](agent-demo-guide.md)**. In Step 1, check for Codex instead of Claude Code:

```bash
codex --version       # installed and signed in (`codex login`)
```

At the end you should have:
- `hushjot` installed (from npm, or built from source);
- the key cached (`hushjot ls` works without asking for the passphrase);
- `Projects/demo-app` containing **Requirements**;
- `hushjot scope Projects` set, and `hushjot mcp enable` run.

### Step 2. Create the code project and register the server

macOS / Linux:

```bash
mkdir -p ~/code/demo-app && cd ~/code/demo-app

codex mcp add hushjot -- hushjot mcp --agent Codex --scope "Projects/demo-app"
codex mcp list        # hushjot should be listed
```

Windows:

```powershell
New-Item -ItemType Directory -Force "$HOME\code\demo-app" | Out-Null
Set-Location "$HOME\code\demo-app"

codex mcp add hushjot '--' cmd /c hushjot mcp --agent Codex --scope "Projects/demo-app"
codex mcp list
```

On Windows, `hushjot` is a `.cmd` script, so it's started through `cmd /c`, and PowerShell needs the `--` quoted. See Step 8 of the [Claude Code guide](agent-demo-guide.md).

- **Everything after `--` is passed to `hushjot` unchanged.** `--agent Codex` makes the boxes in your notes read `Codex may continue.`, and `--scope` gives this server one folder.
- `codex mcp add` writes to **`~/.codex/config.toml`**, which every Codex project shares. For a second project with a different folder, register a second server under another name (`hushjot-other`), or use a project config (below).

Now open `~/.codex/config.toml` (on Windows, `%USERPROFILE%\.codex\config.toml`) and add three lines under the new entry:

```toml
[mcp_servers.hushjot]
command = "hushjot"
args = ["mcp", "--agent", "Codex", "--scope", "Projects/demo-app"]
startup_timeout_sec = 30                 # default 10; the first pull can take longer
tool_timeout_sec = 120                   # default 60
default_tools_approval_mode = "approve"  # run the HushJot tools without asking
```

On Windows, the entry reads `command = "cmd"` and `args = ["/c", "hushjot", "mcp", "--agent", "Codex", "--scope", "Projects/demo-app"]`. Raise `startup_timeout_sec` to 60 there: reading Credential Manager goes through PowerShell, which can add a few seconds to startup.

| Setting | Why |
|---|---|
| `startup_timeout_sec = 30` | The server reads your secret store and pulls your notes before it answers. Ten seconds can be tight on a slow network. |
| `default_tools_approval_mode = "approve"` | Lets the agent use the HushJot tools while you're away. `"writes"` is the cautious alternative: it asks before any tool that isn't marked read-only. |

**Project-only registration (optional).** Codex also reads `.codex/config.toml` inside a project, but only once you've marked the project as trusted (Codex asks the first time you open it). Put the `[mcp_servers.hushjot]` block there instead to keep each project's folder with the project.

**Environment variables.** Codex passes MCP servers only a short list of variables (`HOME`, `PATH`, `USER` and a few more). If you rely on `HUSHJOT_HOME` or `HUSHJOT_PASSPHRASE`, name them: `env_vars = ["HUSHJOT_HOME"]`.

### Step 3. Deny the shell route to your keys

Create **`~/.codex/rules/hushjot.rules`** (on Windows, `%USERPROFILE%\.codex\rules\hushjot.rules`):

```python
prefix_rule(
    pattern = ["hushjot"],
    decision = "forbidden",
    justification = "Use the HushJot MCP tools; the CLI can widen the folder scope.",
)
prefix_rule(
    pattern = ["security"],
    decision = "forbidden",
    justification = "The macOS Keychain holds the HushJot key.",
)
prefix_rule(
    pattern = ["secret-tool"],
    decision = "forbidden",
    justification = "The Linux keyring holds the HushJot key.",
)
```

On Windows there's no single command to forbid: any PowerShell script can read Credential Manager. The rules still stop the agent running `hushjot` itself.

Check the rules work:

```bash
codex execpolicy check --rules ~/.codex/rules/hushjot.rules -- hushjot scope clear   # forbidden
codex execpolicy check --rules ~/.codex/rules/hushjot.rules -- npm test             # no match
```

- `forbidden` beats every other rule.
- Codex labels rules as experimental. Run the check again after Codex updates.
- **Never pass `--ignore-rules`** to `codex exec`.

### Step 4. Choose the approval and sandbox modes

Add to `~/.codex/config.toml`:

```toml
sandbox_mode = "workspace-write"
approval_policy = "on-request"
approvals_reviewer = "auto_review"   # the nearest thing to Claude Code's auto mode

[sandbox_workspace_write]
network_access = true                # so `npm install` works
```

| Mode | For this demo |
|---|---|
| `read-only` sandbox | **Don't use it.** Codex can't write the code. (The HushJot tools would still work.) |
| `workspace-write` + `auto_review` | **Use this.** Edits inside the project, with routine approvals reviewed automatically. |
| `danger-full-access` / `--yolo` | Don't. |

- **The HushJot boxes are your control point.** The protocol tells Codex not to build until you approve the plan. Codex doesn't enforce the box; your rules and sandbox are enforced.
- **Allow in advance what you'll ask for from your phone**, such as `git commit`. A prompt at the terminal waits until you're back. Add `prefix_rule(pattern = ["git", "commit"], decision = "allow")` and similar to a rules file.

### Step 5. Install the skill and an AGENTS.md line

The skill is a backup copy of the protocol, and comes with the CLI. Codex looks in `~/.agents/skills`.

macOS / Linux:

```bash
mkdir -p ~/.agents/skills
cp -r "$(npm root -g)/@hushjot/cli/skills/hushjot-project" ~/.agents/skills/
```

Windows:

```powershell
New-Item -ItemType Directory -Force "$HOME\.agents\skills" | Out-Null
Copy-Item -Recurse -Force "$(npm root -g)\@hushjot\cli\skills\hushjot-project" "$HOME\.agents\skills\"
```

From a source build, copy `path/to/hushjot-cli/skills/hushjot-project` instead.

And add this line to **`~/code/demo-app/AGENTS.md`**:

```markdown
This project's requirements, questions, plan and docs live in HushJot. Follow the HushJot protocol (call hushjot_protocol if you don't have it). You are "Codex" in the notes.
```

---

## Part 2: Running the demo

### Step 6. Check the connection

```bash
cd ~/code/demo-app
codex
```

Inside Codex, type `/mcp`. `hushjot` should be listed with 11 tools. If not, see Troubleshooting.

### Step 7. Start planning

Codex has no MCP prompts, so ask in words:

```
Plan the HushJot project: read the requirements and ask me questions in HushJot.
```

Codex should:
1. read **Requirements** and **Agent instructions**;
2. create **`Questions 01: …`** ending with `- [ ] I have answered all questions. Codex may continue.`;
3. stop, and say the questions are waiting in HushJot.

### Step 8. Answer on your phone, and test the autosave guard

1. Answer the first question only. **Don't tick the box.**
2. In Codex, type `Continue the HushJot project.` **Expected:** it calls `hushjot_pending`, sees the note is *waiting*, and stops without writing.
3. Answer the rest and **tick the box**.
4. `Continue the HushJot project.` again. **Expected:** `> Codex picked this up · <time>` appears under your box, and Codex carries on to follow-up questions or `Docs/Plan`.

### Step 9. Let it run while you're away

Codex has no `/loop`. Choose one of these.

**A. A shell loop (recommended).** Quit interactive Codex, then in a second terminal.

macOS / Linux:

```bash
cd ~/code/demo-app
while hushjot pending --wait --folder "Projects/demo-app"; do
  codex exec resume --last "Continue the HushJot project."
done
```

Windows:

```powershell
Set-Location "$HOME\code\demo-app"
while ($true) {
  hushjot pending --wait --folder "Projects/demo-app"
  if ($LASTEXITCODE -ne 0) { break }
  codex exec resume --last "Continue the HushJot project."
}
```

- **Keep the computer awake** while you're out: `caffeinate -i` on macOS, `systemd-inhibit` on Linux, `powercfg` on Windows. Step 10 of the [Claude Code guide](agent-demo-guide.md) has the exact commands.
- `hushjot pending --wait` checks every 2 minutes and returns as soon as you tick a box. Codex isn't started, and costs nothing, until then.
- `codex exec resume --last` continues the session from Steps 7 and 8, so Codex keeps its context. Use `codex exec` without `resume --last` for a fresh session each time; the notes carry the state either way.
- The loop stops if `hushjot` hits something only you can fix, such as being signed out. Press Ctrl+C to stop it yourself.

**B. A Codex app Automation.** In the Codex app, create an automation for `~/code/demo-app` with the prompt `Continue the HushJot project.` every 15 minutes. Local automations need the computer awake and the app running. Each run costs one `hushjot_pending` call when nothing is ready.

Then, on your phone:

- **Questions NN:** answer, then tick the last box.
- **Docs/Plan:** write changes and tick the last box → a revised plan. Or tick **Approve** and the last box → Codex builds.
- **Inbox:** tick suggestions or write requests, then tick **Done** → Codex does them and posts a new report.

These are the same as Steps 15 to 18 of the [Claude Code guide](agent-demo-guide.md), with "Codex" in place of "Claude".

### Step 10. Clean up afterwards (optional)

```bash
codex mcp remove hushjot
rm ~/.codex/rules/hushjot.rules     # only if you no longer want the deny rules (Windows: Remove-Item)
hushjot mcp disable
hushjot logout                      # forget the key, password and token
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `/mcp` shows hushjot failed or timed out | The server took longer than `startup_timeout_sec`, or exited | Run `hushjot mcp --agent Codex --scope "Projects/demo-app"` in a terminal: errors print there; a healthy server waits silently. Raise `startup_timeout_sec`. |
| "Cannot start the MCP server … passphrase" | The key isn't in your secret store | Run `hushjot ls` once. |
| Windows: `spawn hushjot ENOENT`, or the server never connects | Codex can't start `hushjot.cmd` directly | Use `command = "cmd"`, `args = ["/c", "hushjot", …]`. |
| Windows: the server starts in a terminal but not from Codex | Codex passes MCP servers a short list of variables | Add `env_vars = ["USERPROFILE", "APPDATA", "SystemRoot"]` to the server's block, and note here which ones were needed. |
| A variable such as `HUSHJOT_HOME` is ignored | Codex doesn't pass it to MCP servers | Add `env_vars = ["HUSHJOT_HOME"]` to the server's block. |
| Every HushJot call asks for approval | The approval mode isn't set | Add `default_tools_approval_mode = "approve"` and restart Codex. |
| Boxes say "Claude may continue." | `--agent Codex` is missing | Add it to `args`. Old Claude boxes still work. |
| Codex acted on a note you hadn't ticked | It didn't get the protocol | Check `/mcp` shows the server connected, install the skill and the AGENTS.md line (Step 5), and say "follow the HushJot protocol". |
| The project config is ignored | The project isn't trusted | Open the project in Codex and trust it, or use `~/.codex/config.toml`. |
| `codex exec` stops at an approval | `exec` can't ask anyone | Allow the command with a `prefix_rule(... decision = "allow")`. |

## Quick reference

```bash
# one-time: HushJot Steps 1–7 from agent-demo-guide.md (npm install -g @hushjot/cli, login, scope, mcp enable), then
mkdir -p ~/code/demo-app && cd ~/code/demo-app
codex mcp add hushjot -- hushjot mcp --agent Codex --scope "Projects/demo-app"
#   Windows: codex mcp add hushjot '--' cmd /c hushjot mcp --agent Codex --scope "Projects/demo-app"
#   ~/.codex/config.toml: startup_timeout_sec = 30, default_tools_approval_mode = "approve"
#   ~/.codex/rules/hushjot.rules: forbid hushjot, security, secret-tool
cp -r "$(npm root -g)/@hushjot/cli/skills/hushjot-project" ~/.agents/skills/

# in Codex
/mcp
Plan the HushJot project.

# unattended (keep the computer awake; Windows: the PowerShell loop in Step 9)
while hushjot pending --wait --folder "Projects/demo-app"; do
  codex exec resume --last "Continue the HushJot project."
done
```
