# project-tile

A Claude Code mod for the **Claude desktop app** (Code tab). It shows every session of the current project folder in one place, with what each one is doing and what is waiting for you:

- a one-line row above the prompt: `Project ▸  ● 2 need you  ● 1 next step  ● 1 running`
- a **Project** pane (click `Project ▸`, or run `/project-tile`) with one line per session, ordered by the most recent message, side chats under the session they came from.

Works on Windows, macOS and Linux.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install project-tile --marketplace lil-pava/project-tile
```

answer `y` to add the marketplace, then pick the user scope. From a shell:

```
claude plugin install project-tile --marketplace lil-pava/project-tile
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `lil-pava/project-tile`, then **Add plugin**.

The pane appears in sessions started after the install.

### Requirements

- The Claude desktop app: the pane lists the sessions the app keeps. Sessions run only from a terminal are not listed.
- [Node.js](https://nodejs.org) 18 or later. The pane runs a small collector script with it. When the app does not find `node` on its PATH (an app started from the macOS Dock sees a short PATH), it also tries `/opt/homebrew/bin/node`, `/usr/local/bin/node` and `/usr/bin/node`; otherwise set the `nodePath` option.

## What the pane shows

Each session has a status, its title (click it to open the session), how long ago it last moved, and a one-line summary (`⋯` shows the full text and the files it edited last).

| Status | Meaning |
| --- | --- |
| **Failed** | an API error, or a background job that failed |
| **Permission** | waiting for you to approve a tool call |
| **Needs input** | a question, or a plan waiting for approval |
| **Next step** | finished with a suggested next step; its buttons answer it from the pane |
| **Running** | working now |
| **Waiting** | idle, with a background job or a scheduled wake-up still pending |
| **Stopped** | you stopped it |
| **Done** | finished, with a summary |
| **Idle** | nothing to report |
| **Stale** | untouched for more than 3 days; hidden behind "Show N stale", with an Archive button |

- **Filters:** All, Needs you, Running (everything using resources: working, background jobs, Wolfram computations), By group (the app's sidebar groups).
- **Side chats:** a session with side chats has a ▾/▸ toggle in place of its dot. Folded, its row shows the most important status of the whole family (in the order of the table), the side chat it comes from and the family's newest time. A family counts as stale only when all its sessions are.
- **Alerts:** a toast when a session switches to Needs input, Permission or Failed; the pane's title counts the sessions that need you.
- **Replies:** the buttons of a "Next step" send their label to that session as a message, which arrives as "From \<this session's title\>".

### Resources

The line at the bottom of the pane appears when there is something to show:

- **Wolfram kernels**, when any run: each kernel, the session holding it and whether it is computing (more than 10% of a core between two checks). A session whose Wolfram call is computing, or that started a `wolframscript` job, counts as running.
- **A PBS cluster**, when the `clusterHost` option is set: your jobs from `qstat`, with array jobs counted by state. ssh must work without a password, through a key or a shared ControlMaster connection (`ssh -fN <host>`). On Windows ssh runs inside WSL.

## Options

Set them with `/plugin configure project-tile` in Claude Code, or `claude plugin configure project-tile@lil-pava --values-stdin` with a JSON object.

| Option | Default | Meaning |
| --- | --- | --- |
| `clusterHost` | empty | `user@host` of a PBS cluster to show; empty for none |
| `clusterName` | `Cluster` | the cluster's name in the pane |
| `nodePath` | empty | the `node` executable to use; empty to look for it |

## How it works

`scripts/collect.mjs` reads, on your machine only:

- the app's record of each session (`claude-code-sessions` in the app's data folder: `%APPDATA%\Claude` on Windows, `~/Library/Application Support/Claude` on macOS, `~/.config/Claude` on Linux),
- the running Claude Code processes (`~/.claude/sessions`) and the end of each transcript (`~/.claude/projects`),
- the process list (PowerShell on Windows, `ps` elsewhere) for the Wolfram kernels.

Sessions refresh every 20 seconds and after each turn; the cluster every 2 minutes while the pane is open. Nothing leaves the machine except the ssh call to your cluster and the messages you send with the reply buttons.

## Limitations

- The pane opens as its own column. The app can place a mod's pane in its side column (with Environment and Context) only for a request that current Claude Code versions do not let a mod make.
- A session waiting for a permission is recognised from its process status; a tool that runs for more than 90 seconds is marked "maybe waiting for approval".
- The macOS and Linux paths are checked with recorded `ps` output, not yet on those systems.

## Development

```
claude plugin test .
node --test scripts/ps.check.mjs
```

## License

MIT, see [LICENSE](LICENSE).
