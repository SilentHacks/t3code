# Oh My Pi

T3 Code can use an existing [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi) installation.
OMP runs on the environment hosting the T3 Code server, including when you connect from web,
desktop, mobile, or T3 Connect. OMP 18.6.0 is the integration baseline.

## Set up OMP

1. Install OMP on the server machine using OMP's installation instructions.
2. Run `omp` in a terminal on that machine and complete your usual provider sign-in or API-key setup.
3. On web or desktop, open **Settings → Providers**, add **Oh My Pi**, and enable the instance.
   On mobile, open **Settings → Provider accounts** for the connected environment.
4. If `omp` is not on the server's `PATH`, set the executable path. Set a profile name if you use a
   named OMP profile; leave it empty to use OMP's environment-selected/default profile.

Use separate provider instances for separate profiles. Executable paths, profiles, and provider
credentials belong to the selected environment, not to the browser or phone. Instance environment
variables apply to that instance; existing OMP configuration and authentication remain in OMP's
own store. Removing a T3 provider instance does not delete OMP's native history or credentials.

**Usage → Tokens** reads OMP's native session journals, including work done outside T3 and history
from disabled instances. Copied fork history is counted once. Native token counts and reported costs
are retained; unknown model prices are not guessed. Subscription quota bars appear only when OMP's
read-only usage probe supports the account, so a local model may have token history without quotas.

## Models and native features

The model picker uses OMP's advertised model IDs rather than a fixed model catalog. **OMP default**
keeps the model OMP chooses. Custom model IDs must match OMP exactly, including case and the
`provider/model` prefix. Thinking choices depend on the selected model and update from OMP's
session configuration.

Commands, skills, permissions, questions, plans, usage, and context information appear when the
running OMP session advertises or sends them. Features that OMP does not advertise are not enabled.
Some native terminal widgets and extension-specific interfaces do not have a T3 equivalent.
Use T3's new-thread and worktree controls instead of OMP's `/fresh`, `/move`, `/wt`, or `/worktree`
commands. Those commands are unavailable inside managed T3 threads.

T3 Code launches OMP with an explicit approval mode. Supervised uses OMP's `always-ask`;
Auto-accept edits uses `write`, which still asks before shell execution; Full access uses `yolo`.
Auto uses OMP's unrestricted `--auto-approve` mode. These policies are not an operating-system sandbox.
Trusted extensions can execute code outside tool calls, so only load extensions you trust.

## Bring in existing projects

Onboarding can discover projects from enabled OMP instances. It reads the native workspace metadata,
not the lossy session-directory name, and respects the instance's profile and home configuration.
OMP's default sessions directory is `~/.omp/agent/sessions`; named profiles and migrated XDG data
locations use their corresponding session directories.

Import keeps the native session ID and instance binding. Recent OMP v3 journals contribute visible
user and assistant text from the current branch, with up to 200 messages. Images, private reasoning,
tool output, and abandoned branches are not imported as chat messages. Malformed or over-limit
journals are skipped. Custom session files stored outside OMP's managed session directories are not
discovered by onboarding.

Native resume is separate from restoring workspace files. OMP session import or native whole-session
fork support does not promise rollback or a native fork at an arbitrary T3 turn.

Close an OMP session in its original terminal or T3 environment before continuing its imported history
elsewhere. OMP 18.6.0 can change its native session ID when another process owns the journal without
announcing the replacement over ACP. T3 does not guess identity mappings or adopt unrelated output;
it reports an error if the reply arrives only under an unknown ID. Close the original owner and
restart the affected provider session before retrying. Empty journals have no conversation to import
and are skipped alongside malformed or over-limit journals.

## Generated titles and Git text

OMP can generate thread titles, branch names, commit messages, and pull-request text when selected
as a system model. These helpers use short-lived, tools-disabled sessions in an empty temporary
workspace, not your repository. They reject tool work, permission requests, questions, cancelled
responses, and invalid structured output. A failed helper reports an error rather than accepting
partial output.

## Troubleshooting

- If OMP is unavailable, check the executable and profile on the selected server, then refresh the
  provider. Authentication must be valid on that server and for that profile.
- If a model is missing, verify it in OMP directly. A custom model entry does not install a model or
  grant access to it.
- If existing projects are missing, enable the intended instance and check its profile and home
  variables. Onboarding skips disposable T3 worktrees and malformed transcripts.
- If a generated title or Git operation fails, select another system model or retry after fixing OMP's
  authentication. These unattended helpers cannot answer startup questions for you.
