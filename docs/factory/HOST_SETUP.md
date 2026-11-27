# Setting up a factory host

This guide sets up the software factory of the [design](DESIGN.md) on a Linux host of your own: the
dispatcher, which polls GitHub and publishes as the factory's bot, and the runner, which runs a
coding agent in a rootless container. It describes no real machine. A value that belongs to your
host is written as a placeholder in angle brackets, such as `<runner-uid>`; replace each one.

The guide uses the names below. Any other names work, as long as they are used everywhere.

| Name | What it is |
| --- | --- |
| `factory-dispatcher` | The user that runs the dispatcher. It holds the GitHub App's private key. |
| `factory-runner` | The user that runs the runner and the agent's containers. It holds the Claude token. |
| `factory` | The group both users are in. It shares the checkout, the spool and the mirror. |
| `/srv/factory/app` | The checkout of `main` that both programs run from. |
| `/srv/factory/spool` | The spool, where the two programs exchange job and run files. |
| `/srv/factory/mirror` | The dispatcher's mirror of the repository, which the runner clones from. |

Commands marked **as root** need root. Commands marked **as the dispatcher** or **as the runner**
run in a shell of that user that has the user's own systemd manager and runtime directory, which
`systemctl --user` and rootless Podman need. `sudo machinectl shell factory-runner@` opens such a
shell (`machinectl` comes in the `systemd-container` package on Debian and Ubuntu). A shell opened
with `sudo -u factory-runner -H bash` works too, once `export XDG_RUNTIME_DIR=/run/user/$(id -u)`
is typed in it; that directory exists once lingering is on (section 2).

## What is built and what is not

The ad-hoc pipeline runs end to end: a trusted person labels an issue `factory:fix`, and the factory
answers with a draft pull request from its bot, or with questions on the issue. These parts of the
design are not built yet:

- the per-app checks in CI and the automated second-model review of each pull request;
- fix rounds started by failed checks or review findings;
- the hand-off from draft to ready: a pull request stays a draft until a person marks it ready;
- revise runs started by a person's review, and `/factory revise`;
- the epic pipeline: the `factory:epic` label starts nothing;
- service containers: a run for an app that declares services is refused.

## 1. What the host needs

- Linux with systemd (user managers and lingering), cgroup v2 and nftables. Design section 12
  lists the requirements and the rules for a host that is shared with other software.
- Outbound access to the internet. No inbound port is opened: the factory only connects out.
- Python 3.11 or newer as `/usr/bin/python3`, git 2.39 or newer, and the `openssl` command, which
  signs the GitHub App's tokens.
- Rootless Podman 4.3 or newer, which the runner needs for `--userns=keep-id:uid=<n>,gid=<n>`, with
  `slirp4netns` for the agent's network and the `newuidmap` and `newgidmap` helpers (the `uidmap`
  package on Debian and Ubuntu).
- Memory and processor time to spare: agent runs build and test real apps (section 4).

The host needs neither Node.js nor Claude Code: the agent image brings both.

## 2. Users, group and directories

As root:

```sh
groupadd factory
useradd --create-home --shell /bin/bash --groups factory factory-dispatcher
useradd --create-home --shell /bin/bash --groups factory factory-runner
install -d -o root -g factory -m 0750 /srv/factory
install -d -o factory-dispatcher -g factory -m 2750 /srv/factory/app /srv/factory/spool /srv/factory/mirror
loginctl enable-linger factory-dispatcher factory-runner
grep factory-runner /etc/subuid /etc/subgid
```

Create both as ordinary users, not system users. An ordinary user gets a journal of its own and
subordinate user and group ids, which rootless Podman needs; the last command shows them. If it
prints nothing, give the runner a range with `usermod --add-subuids <first>-<last> --add-subgids
<first>-<last> factory-runner`. Lingering starts each user's systemd manager at boot, so the
services run while nobody is logged in.

| Path | Owner, group | Mode | Holds |
| --- | --- | --- | --- |
| `/srv/factory` | `root`, `factory` | `0750` | The three directories below. |
| `/srv/factory/app` | `factory-dispatcher`, `factory` | `2750` | The checkout of `main`. |
| `/srv/factory/spool` | `factory-dispatcher`, `factory` | `2750` | `jobs/` and `runs/`. |
| `/srv/factory/spool/jobs` | `factory-dispatcher`, `factory` | `2750` | A directory per job, written by the dispatcher. |
| `/srv/factory/spool/runs` | `factory-dispatcher`, `factory` | `2770` | A directory per run, which the runner creates. |
| `/srv/factory/mirror` | `factory-dispatcher`, `factory` | `2750` | `repo.git`, the mirror. |
| `~/.config/factory` of each user | the user | `0700` | The user's environment files, and the App's key or the Claude token. |
| `~/.local/state/factory` of the dispatcher | `factory-dispatcher` | `0700` | `work.git`, where bundles are checked, and scratch files. |
| `~/.local/state/factory` of the runner | `factory-runner` | `0700` | The runner's lock, the job workspaces and the transcripts. |

The spool's root belongs to the dispatcher, and the runner cannot write in it. The dispatcher
creates `jobs/` and `runs/` when it starts, so it starts first; the runner only checks that
`runs/` exists. `runs/` is group-writable so that the runner can add a directory for each run. The
set-group-id bit (the `2` in `2750`) gives everything created below the group `factory`, and the
services' `UMask=0027` keeps it readable for the group and closed to everyone else. The dispatcher
would create a missing mirror directory as private, so it is created here, where the runner can
read it. Each program creates its own state directory when it starts.

Two runners must never share a spool: the lock that keeps a second runner out covers one work
directory, and a second runner on the same spool would hand a job to two agents.

Rootless Podman uses the slow `vfs` storage driver unless told otherwise. On Linux 5.13 or newer,
switch the runner to native overlay before the first image is built. As the runner:

```sh
mkdir -p ~/.config/containers
printf '[storage]\ndriver = "overlay"\n' > ~/.config/containers/storage.conf
podman info --format '{{.Store.GraphDriverName}}'
```

The last command prints `overlay`.

## 3. Firewall for the runner user

The runner user and its containers may reach the public internet and nothing on the host or its
networks. One nftables table of its own holds the rules. Its `output` chain sends every packet that
a process of the runner user sends to a second chain, which:

1. accepts the packets of connections that are already established;
2. accepts DNS (port 53, UDP and TCP) to the host's resolvers, which may sit on the loopback
   interface or on a private network, so this comes before the rejections;
3. rejects packets to the loopback interface, so that no service on the host's loopback can be
   reached;
4. rejects packets to every address of the host itself;
5. rejects packets to the private and link-local ranges: the three private IPv4 ranges of RFC
   1918, the carrier-grade NAT range of RFC 6598, the IPv4 link-local range, and the IPv6
   unique-local and link-local ranges.

The agent's containers reach the network through `slirp4netns`, a process of the runner user, so
the same rules hold for them. Inside a container the agent has a loopback of its own, which these
rules do not touch. Other users are not affected.

Where another tool, such as Docker, keeps packet-filter rules of its own, the factory must leave
them alone. The file below replaces only its own table, and a unit of its own loads it. Do not
load it through the distribution's `nftables.service`: that service's stock configuration starts
with `flush ruleset`, which removes every other tool's rules.

As root, create the directory with `install -d -m 0755 /etc/factory`, write
`/etc/factory/runner-firewall.nft` as below, and replace the placeholders. `id -u factory-runner`
prints the runner's user id. Write each range in CIDR notation, as its RFC gives
it. The resolvers are the addresses in `/etc/resolv.conf`, and where systemd-resolved runs, also
the servers that `resolvectl status` lists. When the host has no IPv6 resolver, delete the
`RESOLVERS_V6` line and the two rules that use it.

```nft
define RUNNER_UID = <runner-uid>
define RESOLVERS_V4 = { <resolver-ipv4-addresses> }
define RESOLVERS_V6 = { <resolver-ipv6-addresses> }
define PRIVATE_V4 = { <rfc-1918-ranges>, <rfc-6598-range>, <ipv4-link-local-range> }
define PRIVATE_V6 = { <ipv6-unique-local-range>, <ipv6-link-local-range> }

# Replace this table, and only this table, each time the file is loaded.
table inet factory_runner
delete table inet factory_runner

table inet factory_runner {
    chain output {
        type filter hook output priority filter; policy accept;
        meta skuid $RUNNER_UID jump runner
    }

    chain runner {
        ct state established,related accept
        ip daddr $RESOLVERS_V4 udp dport 53 accept
        ip daddr $RESOLVERS_V4 tcp dport 53 accept
        ip6 daddr $RESOLVERS_V6 udp dport 53 accept
        ip6 daddr $RESOLVERS_V6 tcp dport 53 accept
        oifname "lo" reject
        fib daddr type local reject
        ip daddr $PRIVATE_V4 reject
        ip6 daddr $PRIVATE_V6 reject
    }
}
```

As root, write `/etc/systemd/system/factory-runner-firewall.service`:

```ini
[Unit]
Description=Firewall table for the software factory's runner user
DefaultDependencies=no
Wants=network-pre.target
Before=network-pre.target shutdown.target
Conflicts=shutdown.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f /etc/factory/runner-firewall.nft
ExecReload=/usr/sbin/nft -f /etc/factory/runner-firewall.nft
ExecStop=/usr/sbin/nft delete table inet factory_runner

[Install]
WantedBy=sysinit.target
```

Then load it and look at what is loaded:

```sh
systemctl daemon-reload
systemctl enable --now factory-runner-firewall.service
nft list table inet factory_runner
```

**The check that proves it.** The runner checks its own confinement: `python3 -m factory.runner
--check` (section 7, step 6) prints `confinement: ok` when the host refuses it a connection to its
own listener on the loopback address. The runner makes the same probe before every job, and
refuses the job when the connection succeeds. Check it by hand as well, with checks that change
nothing. As the dispatcher, start a listener in an empty directory; it listens on every address of
the host for the moment of the check:

```sh
cd "$(mktemp -d)" && python3 -m http.server 8765
```

As the runner, in another shell:

```sh
curl -sS --max-time 5 http://localhost:8765/; echo "exit $?"
curl -sS --max-time 5 http://<an-address-of-this-host>:8765/; echo "exit $?"
curl -sS --max-time 10 -o /dev/null -w '%{http_code}\n' https://api.github.com/
```

The first two fail (curl cannot connect, exit 7), and the third prints `200`. The same two `curl`
commands run as the dispatcher print the empty directory's listing. Stop the listener with Ctrl-C.

## 4. Resource cap

Agent runs build and test real apps, so they get a fixed budget. It is a setting on the runner
user's slice, enforced by systemd for every process of the user, the containers included. As
root, with the budget your host can spare:

```sh
install -d /etc/systemd/system/user-<runner-uid>.slice.d
cat > /etc/systemd/system/user-<runner-uid>.slice.d/50-factory.conf <<'EOF'
[Slice]
MemoryMax=<memory-budget>
CPUQuota=<cpu-budget>
TasksMax=<task-limit>
CPUWeight=20
IOWeight=20
EOF
systemctl daemon-reload
systemctl show user-<runner-uid>.slice -p MemoryMax -p CPUQuotaPerSecUSec -p TasksMax -p CPUWeight
```

`MemoryMax` takes a size such as `6G`; when the runner's processes need more, the kernel ends one
of them, and nothing outside the slice. `CPUQuota` takes a share of one core, such as `300%` for
three cores. `TasksMax` takes a number of processes and threads, such as `2048`. `CPUWeight` and
`IOWeight` give the runner a smaller share than other users' processes when the host is busy.

## 5. The GitHub App

The App gives the factory its own identity: its pull requests, comments and commits show as
`<app-slug>[bot]`, so the owner can approve them. In the GitHub account that owns the repository:

1. Open Settings, Developer settings, GitHub Apps, and choose New GitHub App.
2. Give it a name; GitHub turns it into the App's slug, as in `https://github.com/apps/<app-slug>`.
   Set the homepage URL to the repository's. Under Webhook, clear Active: the factory polls, and
   nothing connects in.
3. Set the repository permissions exactly as design section 8 lists them, and leave every other
   permission at No access (GitHub adds read access to Metadata itself):

   | Permission | Access |
   | --- | --- |
   | Contents | Read and write |
   | Pull requests | Read and write |
   | Issues | Read and write |
   | Checks, Commit statuses, Actions | Read-only |
   | Workflows, Administration | No access |

4. Under "Where can this GitHub App be installed?", choose "Only on this account", and create it.
5. The App's page shows its App ID: that is `FACTORY_APP_ID`.
6. Under Private keys, generate a private key. The browser downloads a `.pem` file. Copy it to the
   host, then, as root, install it where only the dispatcher can read it, and delete the copy:

   ```sh
   install -d -o factory-dispatcher -m 0700 ~factory-dispatcher/.config ~factory-dispatcher/.config/factory
   install -o factory-dispatcher -m 0600 <downloaded-key-file> ~factory-dispatcher/.config/factory/app.pem
   ```

   Its absolute path is `FACTORY_APP_KEY_FILE`.
7. Install the App on the repository: Install App, "Only select repositories", the repository.
   The installation's page ends in its id, as in `https://github.com/settings/installations/<id>`:
   that is `FACTORY_INSTALLATION_ID`.
8. `FACTORY_BOT_LOGIN` is `<app-slug>[bot]`. `FACTORY_BOT_USER_ID` is the bot's numeric user id,
   which is not the App ID; this prints it:

   ```sh
   curl -s 'https://api.github.com/users/<app-slug>%5Bbot%5D' | python3 -c 'import json, sys; print(json.load(sys.stdin)["id"])'
   ```

   The bot's commits carry the email `<bot-user-id>+<app-slug>[bot]@users.noreply.github.com`,
   which the dispatcher derives from these two values.

Three things in the repository belong with the App:

- `trusted_logins` in `factory/config.toml` lists the GitHub logins whose labels and comments
  count. In a fork, set it to your own login with a commit to `main` before you deploy.
- The labels come from `factory/config.toml`. `python3 -m factory.labels` lists the ones GitHub
  lacks or holds differently, and `python3 -m factory.labels --apply` creates and updates them. Run
  it from a checkout on a machine where `gh` is signed in as a maintainer, not on the host, which
  holds no maintainer's credentials.
- The rulesets and Actions settings of design section 8: GitHub refuses a force push to a
  `factory/` branch and a push to `main` whatever the factory's own code does.

## 6. The Claude token

The runner signs the agent in with a long-lived token of the Claude subscription, which
`claude setup-token` makes after a sign-in in the browser. Run it on any machine where Claude Code
is installed, or, once the image is built (section 7, step 5), in the image as the runner:

```sh
podman run --rm -it --pull=never localhost/factory-agent claude setup-token
```

Store the token as the runner. Type these lines in the runner's own shell:

```sh
mkdir -p -m 0700 ~/.config/factory
umask 077
read -r -s -p 'Token: ' token
printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$token" > ~/.config/factory/claude.env
unset token
chmod 600 ~/.config/factory/claude.env
```

`read -s` keeps the token off the screen and out of the shell's history, and `printf` is built
into the shell, so the token never appears in a list of processes. Do not wrap these lines in
`sudo -i -u factory-runner bash -c '...'`: with `-i`, the outer shell expands `$token` before
`read` sets it, and the file gets an empty value. To check the file without showing the token,
`wc -c ~/.config/factory/claude.env` prints its length, and `stat -c '%a %U'
~/.config/factory/claude.env` prints `600 factory-runner`. The token expires about a year after it
was made; then make a new one, replace the file, and restart the runner.

## 7. Deploying

1. **The checkout.** As the dispatcher:

   ```sh
   umask 0027
   git clone https://github.com/<owner>/<repository>.git /srv/factory/app
   ```

2. **The environment files.** As the dispatcher, then as the runner, copy the user's example and
   fill it in:

   ```sh
   mkdir -p -m 0700 ~/.config/factory
   install -m 0600 /srv/factory/app/factory/deploy/dispatcher.env.example ~/.config/factory/dispatcher.env
   ```

   The runner copies `runner.env.example` to `~/.config/factory/runner.env` the same way. Its
   `claude.env` (section 6) has to exist before the check in step 6.

   | Variable | File | Value |
   | --- | --- | --- |
   | `FACTORY_REPOSITORY` | `dispatcher.env` | The repository as `<owner>/<repository>`. |
   | `FACTORY_APP_ID` | `dispatcher.env` | The App ID (section 5, step 5). |
   | `FACTORY_INSTALLATION_ID` | `dispatcher.env` | The installation's id (section 5, step 7). |
   | `FACTORY_APP_KEY_FILE` | `dispatcher.env` | The absolute path of the App's key (section 5, step 6). |
   | `FACTORY_BOT_LOGIN` | `dispatcher.env` | `<app-slug>[bot]`. |
   | `FACTORY_BOT_USER_ID` | `dispatcher.env` | The bot's user id (section 5, step 8). |
   | `FACTORY_SPOOL_DIR` | both | `/srv/factory/spool`. |
   | `FACTORY_MIRROR_DIR` | both | `/srv/factory/mirror`. |
   | `FACTORY_STATE_DIR` | `dispatcher.env` | `<dispatcher-home>/.local/state/factory`. |
   | `FACTORY_WORK_DIR` | `runner.env` | `<runner-home>/.local/state/factory`. |
   | `FACTORY_IMAGE` | `runner.env` | The name the image is built under: `localhost/factory-agent`. |
   | `CLAUDE_CODE_OAUTH_TOKEN` | `claude.env` | The Claude token (section 6). |

   systemd does not expand `~` or `%h` inside these files, so every directory is written out as an
   absolute path. The runner's directories may not contain a colon or a comma. Both systemd and
   the shell read the files, so each value stays plain: no quotes, no spaces, and comments on
   lines of their own. A program that finds a variable missing or malformed exits with status 2
   and names the variable, never its value.

3. **A dry run.** As the dispatcher:

   ```sh
   cd /srv/factory/app
   (set -a && . ~/.config/factory/dispatcher.env && set +a && python3 -m factory.dispatcher --dry-run)
   ```

   It reads GitHub as the bot and prints one line for each action a poll would take, such as
   `issue #12: start a fix_issue run for app <app>`, and writes nothing anywhere. No output means
   there is nothing to do. A failure is logged with its kind: `AuthError` when `openssl` cannot
   sign with the key, `GitHubError` when GitHub refuses a request, for example for a wrong App ID
   or installation id. The parentheses keep the settings out of your shell.

4. **Start the dispatcher.** If labelled issues are open already, first add the `factory:halt`
   label to any open issue, so that no run starts before the runner is ready. As the dispatcher:

   ```sh
   mkdir -p ~/.config/systemd/user
   cp /srv/factory/app/factory/deploy/factory-dispatcher.service ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now factory-dispatcher.service
   journalctl --user -u factory-dispatcher -n 20
   ls -ld /srv/factory/spool/jobs /srv/factory/spool/runs
   ```

   The last command shows `drwxr-s---` for `jobs` and `drwxrws---` for `runs`.

5. **Build the image.** As the runner:

   ```sh
   cd /srv/factory/app
   (set -a && . ~/.config/factory/runner.env && set +a && python3 -m factory.image.build)
   ```

   It builds `factory/image/Containerfile` with the base image and the Claude Code version that
   `factory/config.toml` names, and labels the image with a digest of the harness: the hooks, the
   Claude Code settings, the factory's modules and configuration, and the image's own files. The
   image installs the hooks as system-level settings that a file in a checkout cannot override.
   The harness copy and the Claude Code CLI are owned by root, and what the agent installs globally
   goes to its own home directory, last on its `PATH`, so nothing the agent can write comes before
   the system's programs.
   `python3 -m factory.image.build --print-digest` prints the digest of the checkout, and before
   every job the runner compares the two. The build downloads from public registries, so it is
   also the first proof that the runner's containers resolve names and reach the internet under
   the firewall.

6. **Check.** As the runner:

   ```sh
   (set -a && . ~/.config/factory/runner.env && . ~/.config/factory/claude.env && set +a && python3 -m factory.runner --check)
   ```

   On a healthy host it prints these three lines and exits with status 0:

   ```text
   confinement: ok
   image: ok
   spool: ok
   ```

   Any other line names what to fix: the firewall (section 3), the image (step 5), or the spool,
   which exists once the dispatcher has started (step 4). The check creates the work directory and
   a temporary file in it, and takes no lock.

7. **Start the runner.** As the runner:

   ```sh
   mkdir -p ~/.config/systemd/user
   cp /srv/factory/app/factory/deploy/factory-runner.service ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now factory-runner.service
   journalctl --user -u factory-runner -n 20
   ```

   Then remove `factory:halt`, if you added it.

The runner holds an exclusive lock in its work directory, so one runner runs per host; a second
one exits with "another runner holds the lock on the work directory". For another layout, change
`WorkingDirectory=` in both copied unit files and the directories in the environment files; to
use another Python, change `ExecStart=`.

## 8. Updating

1. Add `factory:halt` to any open issue. No new run starts, and finished runs are still published.
2. Wait until no run is going on: as the runner, `podman ps --format '{{.Names}}'` lists no name
   that starts with `factory-`. A run that is still going when the runner stops ends as **ended
   without a result** with the reason `internal`, and `/factory retry` runs it again.
3. As the dispatcher, `git -C /srv/factory/app pull --ff-only`. Then
   `git -C /srv/factory/app diff --stat ORIG_HEAD HEAD -- factory/deploy` shows whether a unit or
   an example file changed: copy a changed unit again (repeating any change made for another
   layout), and add any new variable to the environment file.
4. As the runner, rebuild the image (section 7, step 5) and run the check (step 6). The runner
   refuses to work with an image that does not match the deployed harness: until the image is
   rebuilt, every job is refused with the reason `image`.
5. Restart both, each as its own user: `systemctl --user daemon-reload`, then
   `systemctl --user restart factory-dispatcher.service` as the dispatcher and
   `systemctl --user restart factory-runner.service` as the runner. Each program reads
   `factory/config.toml` when it starts.
6. Remove `factory:halt`.

## 9. Operating

### Labels a person applies

| Label | Effect |
| --- | --- |
| `factory:fix` | The factory takes the issue: one small change, a bug fix, a small feature or a chore, as one pull request. It counts only when the person who applied it last is in `trusted_logins`. |
| `factory:pause` | No new run starts for this issue; a run that is going on finishes and is published. It counts from anyone, since stopping is always safe. |
| `factory:halt` | On any open issue: no new run starts anywhere; runs that are going on finish and are published. It counts from anyone. |

Removing `factory:fix` or closing the issue drops a run that has not started, and a run that ends
afterwards is not published. The `factory:epic` label starts nothing yet.

### Status labels

The dispatcher keeps at most one status label on each issue it handles.

| Label | Means |
| --- | --- |
| `status:queued` | The issue waits to start: another run is going on, the issue is paused, the factory is halted, or a usage limit holds. |
| `status:building` | A run is queued, going on or being published, or its draft pull request is open. |
| `status:needs-human` | The factory waits for a person: a question, a failure, a notice, or a pull request closed without merging. |
| `status:done` | The issue's pull request is merged. |

A closed issue whose pull request was not merged loses its status label. `status:design` and
`status:plan` belong to the epic pipeline.

### Steering

Only comments by people in `trusted_logins` steer. Comments by anyone else are never passed to the
agent and start nothing.

| Signal from a trusted person | Effect |
| --- | --- |
| A comment after a question, or after a notice that asks for something | The next run starts, with the comment in its context, from the commits the last run left on the work branch. |
| `/factory retry` as the first line of a comment | After a run that **failed**, **timed out**, **ended without a result**, was **not started** or had its **work not published**, or after the pull request was closed without merging: the run starts again from the work branch. |
| A line `app: <name>` in a comment | The run works on the app in `apps/<name>`. The last such line counts, and a name that is no app gets the notice that asks for one. Without such a line, the App field of the issue form counts when the issue's author is trusted, and then the only app, when there is one. |

The factory posts a notice and waits in three cases. When it cannot tell the app, it asks for an
`app:` line. When the issue's author is outside the trusted list, the agent is never shown the
issue's title or body, and a trusted person restates the request in a comment; the run starts from
that comment. When the pull request is closed without merging, `/factory retry` runs again.

### Run comments

Every run leaves one comment on its issue. Its first line names the stage, the outcome word, the
duration and the model; the agent's summary, questions, reason and follow-ups come under fixed
lead-ins, and a hidden marker at the end names the job and the outcome.

| Outcome word | Marker | What happened | What starts the next run |
| --- | --- | --- | --- |
| **done** | `done` | The agent finished, and its commits passed the checks. They are on the work branch `factory/fix-<issue>`, and a draft pull request is open or updated; the comment links it. | Nothing: a person marks the pull request ready, reviews it and merges it. |
| **needs input** | `needs_input` | The agent asked the numbered questions. Commits that passed the checks are on the work branch, without a pull request. | A comment by a trusted person. |
| **failed** | `failed` | The agent could not finish; the comment quotes its reason. | `/factory retry`, once the cause is fixed. |
| **timed out** | `timeout` | The run reached the stage's `timeout_minutes` in `factory/config.toml`, and its container was stopped. | `/factory retry` |
| **ended without a result** | `crashed` | The run ended with nothing to publish; a reason says why (below). | `/factory retry` |
| **not started** | `refused` | The runner refused the job before the agent started; a reason says why (below). | `/factory retry` |
| **work not published** | `rejected` | The result's text or its commits failed the dispatcher's checks. The comment lists the problems, without quoting a secret or a host path, and nothing was pushed. | `/factory retry` |
| **waiting for the usage limit** | `usage_limit` | The subscription's usage limit stopped the run. | Time: the run starts again by itself (below). |

### Reasons

A run that is **not started** or **ended without a result** names its reason in the line "This
run ended because ...".

| Reason | Outcome word | The comment says it ended because | What to do |
| --- | --- | --- | --- |
| `firewall` | not started | the host's confinement check failed, so no agent was started | The firewall table is not loaded. Look at `systemctl status factory-runner-firewall` (section 3), run the check, then `/factory retry`. |
| `image` | not started | the agent image is missing or does not match the deployed harness | Rebuild the image as the runner (section 7, step 5), run the check, then retry. It follows an update that skipped the rebuild. |
| `toolchain` | not started | the app needs a toolchain the agent image does not have | The app's `factory.toml` on the work branch does not load, or names a toolchain version that `[agent.toolchains]` in `factory/config.toml` does not list. Fix the app's file in a pull request, or have a person add the toolchain to the configuration and the image; then retry. |
| `services` | not started | the app declares service containers, which this version does not run | Service containers are not built yet. Handle the issue by hand, or remove its label. |
| `request` | not started | the request for the agent could not be built | The job's `request.json` is missing or not what the runner expects, which happens when the two programs run different versions. Restart both from the same checkout (section 8), then retry. |
| `clone` | ended without a result | the repository could not be prepared for the agent | The runner could not clone the mirror or check out the work branch in time. Check that the runner can read `/srv/factory/mirror` (section 2) and that its work directory has disk space, then retry. |
| `max_turns` | ended without a result | the run used all its turns | The agent used the stage's `max_turns`. The issue is probably more than one small change: split it, or make it an epic, or retry. |
| `agent_error` | ended without a result | the agent stopped with an error | The agent ended without a valid result file. Read the transcript (below); a retry often succeeds after a passing error of the service. |
| `internal` | ended without a result | the factory hit an internal error | The runner failed in an unexpected way, Podman could not start the container, the runner was stopped during the run (a restart or an update ends a run this way), or the dispatcher could not read the run's record. Read both logs, then retry. |

### The usage limit

When the subscription's usage limit stops a run, the comment says **waiting for the usage limit**
and when the run starts again: at the reset time the agent reported, when that lies within the
next six hours, and otherwise 30 minutes later (`usage_limit_backoff_minutes` in `factory/config.toml`). The
issue shows `status:queued`, and no run starts anywhere until then. Then the issue starts again
by itself, in its turn. A second limit in a row edits that comment instead of adding another.

When GitHub's own rate limit runs out, the dispatcher logs it and waits until the limit resets: at
least a minute, at most an hour.

### Logs, transcripts and job files

- The dispatcher's log, as the dispatcher: `journalctl --user -u factory-dispatcher`, with `-f` to
  follow it. The runner's, as the runner: `journalctl --user -u factory-runner`. A line names the
  action or the job and the kind of error, never a secret. Where a user's journal is not kept
  apart, root reads the same lines with `journalctl --user-unit factory-runner.service`.
- The transcripts, as the runner: `~/.local/state/factory/transcripts/<job-id>.jsonl`, the Claude
  CLI's stream of JSON events, and `<job-id>.err`, its error output, in `FACTORY_WORK_DIR`. Only
  the runner can read them, and they are deleted after 14 days. They can hold anything the agent
  read, so they stay on the host.
- The job files: `/srv/factory/spool/jobs/<job-id>/` holds what the dispatcher wrote:
  `request.json`, `job.json`, `context.md`, and later `settled.json`, the outcome it settled on,
  and `closed.json`, when and why it closed the job. `/srv/factory/spool/runs/<job-id>/` holds what
  the runner wrote: `claimed.json`, `run.json` (status, reason, duration, model and turns),
  `result.json` and `commits.bundle`. A closed job is deleted after 14 days, its run with it.
- A job id reads `<start-time>-fix_issue-<issue>-<random>`, such as
  `20261127T101500Z-fix_issue-12-1a2b3c4d`, and the hidden marker of each run comment names it.
  `ls /srv/factory/spool/jobs | grep -- '-fix_issue-12-'` lists the jobs of issue 12.

### Checks and single steps

- `python3 -m factory.dispatcher --dry-run` prints what one poll would do and writes nothing.
- `python3 -m factory.runner --check` checks confinement, the image and the spool; it writes
  nothing but the work directory and a temporary file in it.
- `python3 -m factory.dispatcher --once` makes one real poll and exits.
- `python3 -m factory.runner --once` handles at most one job and exits; stop the runner's service
  first, since it holds the lock.

Each needs its user's environment files loaded, as in section 7.

## 10. Removing everything

As the runner:

```sh
systemctl --user disable --now factory-runner.service
rm ~/.config/systemd/user/factory-runner.service
podman system reset --force
```

As the dispatcher:

```sh
systemctl --user disable --now factory-dispatcher.service
rm ~/.config/systemd/user/factory-dispatcher.service
```

Close every shell of the two users. Then, as root:

```sh
loginctl disable-linger factory-dispatcher factory-runner
loginctl terminate-user factory-dispatcher factory-runner
systemctl disable --now factory-runner-firewall.service
rm /etc/systemd/system/factory-runner-firewall.service /etc/factory/runner-firewall.nft
rmdir /etc/factory
rm -r /etc/systemd/system/user-<runner-uid>.slice.d
systemctl daemon-reload
userdel --remove factory-dispatcher
userdel --remove factory-runner
groupdel factory
rm -r /srv/factory
```

On GitHub, uninstall the App from the repository and delete its private key, or delete the App.
The Claude token stays valid until it expires or is revoked in the Claude account; deleting
`claude.env` does not end it. The factory's branches, pull requests, comments and labels stay on
GitHub until a person removes them.
