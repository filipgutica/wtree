<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { UiCard, UiCodeBlock } from '@filipgutica/ui';
import { UiCapture, UiCommandList, UiSiteHeader, UiSiteNav } from '@filipgutica/ui/site';
import { captures } from './captures';

const enhanced = ref(false);
onMounted(() => { enhanced.value = true; });

const headerLinks = [
  { label: 'GitHub', href: 'https://github.com/filipgutica/wtree' },
  { label: 'Releases', href: 'https://github.com/filipgutica/wtree/releases' },
];
const sections = [{ items: [
  { label: 'Install', href: '#install' },
  { label: 'Inspect worktrees', href: '#inspect-title' },
  { label: 'Preview and remove', href: '#cleanup-title' },
  { label: 'Set up wt', href: '#shell-title' },
  { label: 'Commands', href: '#commands-title' },
  { label: 'Keys in wtree ui', href: '#keys-title' },
  { label: 'Safety and exit codes', href: '#limits-title' },
] }];
const commands = [
  { command: 'wtree', description: 'List worktrees, with main first and the rest oldest first.' },
  { command: 'wtree ui', description: 'Inspect worktrees and choose which to remove in the interactive browser.' },
  { command: 'wtree clean --older-than 30d --dry-run', description: 'Preview removal of worktrees older than 30 days. Add --done to require a merged or closed PR too.' },
  { command: 'wtree rm feat/example', description: 'Remove one worktree after confirmation. Replace feat/example with its exact branch name or path. Substrings never match.' },
  { command: 'wtree prune --dry-run', description: 'Preview stale Git worktree records to prune. Drop --dry-run to review and confirm pruning.' },
  { command: 'wtree new feat/example', description: 'Create a worktree and print its path. If the branch already has a live worktree, print that path instead.' },
  { command: 'wtree path feat/example', description: 'Print an existing worktree path. Accepts an exact branch, exact path, or unique substring.' },
  { command: 'wtree go', description: 'Pick a worktree or branch and print its path. A branch without a worktree gets one. Uses fzf if installed.' },
  { command: 'wtree --size' },
  { command: 'wtree --json', description: 'Print the worktree list as JSON.' },
  { command: 'wtree clean --help', description: 'Show every cleanup filter and option. Use --help with any command for its reference.' },
];
const keys = [
  { command: '↑ / ↓', description: 'Move between worktrees.' },
  { command: 'Space', description: 'Toggle selection of the focused worktree. A blocked row stays unselected. The status line explains why.' },
  { command: '/', description: 'Filter by branch or path. Enter applies the filter. Esc cancels it.' },
  { command: 'p', description: 'Cycle the PR filter: all, merged or closed, open, and no PR.' },
  { command: 'a', description: 'Select every removable worktree in the filtered list.' },
  { command: 'c', description: 'Clear all selections.' },
  { command: 'd', description: 'Review selected worktrees for removal. With nothing selected, review the focused worktree if it is removable.' },
  { command: 'b', description: 'Toggle branch deletion. You can also change it on the review screen.' },
  { command: 'f', description: 'Toggle forced selection. Overrides only uncommitted changes, unpushed commits, or a lock. Main and current stay protected.' },
  { command: 'Enter', description: 'Show the full branch name and path of the focused worktree.' },
  { command: 'o', description: 'Quit and print the path of the focused worktree. With wt ui, change into that directory.' },
  { command: 'n', description: 'Create a worktree for a branch.' },
  { command: 'r', description: 'Reload worktrees and fetch PR state again.' },
  { command: 'q / Esc', description: 'Quit from the list, or go back from the review without removing anything.' },
];
const shellCommands = [
  { command: 'eval "$(wtree shell-init zsh)"' },
  { command: 'wt go' },
];
</script>

<template>
  <a class="fg-site-skip" href="#main">Skip to content</a>
  <div class="fg-site-docs" :data-enhanced="enhanced">
    <UiSiteHeader
      project="wtree"
      :links="headerLinks"
    />
    <UiSiteNav label="On this page" :groups="sections" />
    <main id="main">
      <section class="intro" aria-labelledby="title">
        <h1 id="title">Clean up finished Git worktrees.</h1>
        <p class="lede">
          wtree shows each worktree's age, local changes, and GitHub pull request state.
          Review the cleanup plan before you remove finished worktrees.
        </p>
        <div id="install" class="install">
          <p class="fg-site-meta">Install with Homebrew</p>
          <UiCodeBlock
            code="brew install filipgutica/tap/wtree"
            language="bash"
            variant="compact"
            :copyable="enhanced"
            :wrap="true"
          />
          <div class="meta">
            <p class="fg-site-meta">
              Homebrew also installs Node.js.
              <a href="https://brew.sh/">Install Homebrew</a> first if you need it.
              For pull request state, wtree uses the GitHub CLI, <code>gh</code>, which must be signed in.
            </p>
            <dl class="fg-site-facts">
              <div><dt>Runs on</dt><dd>macOS and Linux</dd></div>
              <div><dt>Needs</dt><dd>Git and Node.js 20+</dd></div>
              <div><dt>Source</dt><dd><a href="https://github.com/filipgutica/wtree">filipgutica/wtree</a></dd></div>
            </dl>
          </div>
        </div>
      </section>
      <section aria-labelledby="inspect-title">
        <h2 id="inspect-title">Inspect your worktrees</h2>
        <p class="section-intro">
          In your Git repository, run <code>wtree</code> for a table or <code>wtree ui</code> for the interactive browser.
          Age uses the last commit by default. To use another timestamp, pass
          <code>--age-by checkout</code> or <code>--age-by created</code>.
          Closed PRs can contain unmerged work, so check each proposed removal.
        </p>
        <div class="capture" role="group" aria-label="wtree in use">
          <p class="fg-site-meta">These examples use a demo repository and sample pull requests.</p>
          <UiCapture :items="captures" label="Examples">
            <template #caption="{ item }">
              <p v-if="item.id === 'browse'">
                In <code>wtree ui</code>, move between rows with the arrow keys.
                The panel below the table shows details of the focused worktree.
              </p>
              <p v-else-if="item.id === 'select'">
                Press <kbd>Space</kbd> on each worktree you want to remove.
                Check the selection count beside <kbd>d</kbd>.
                Press <kbd>d</kbd> to review the selection.
              </p>
              <p v-else-if="item.id === 'review'">
                Check the paths and branch deletion setting before removal.
                Press <kbd>y</kbd> to remove the listed worktrees.
                To go back, press <kbd>Esc</kbd>.
              </p>
              <p v-else-if="item.id === 'list'">
                At a terminal, <code>wtree</code> adds a command hint when the listed rows
                include merged or closed PRs, or prunable worktrees.
              </p>
              <p v-else-if="item.id === 'plan'">
                Check each worktree under <code>remove</code>. Blocked matches appear under <code>skip</code>, with the reason.
              </p>
            </template>
          </UiCapture>
        </div>
        <UiCard title="Read the table" title-tag="h3" class="legend">
          <dl class="fg-site-legend">
            <div><dt>PR</dt><dd>Pull request state: open, merged, or closed. <code>-</code> means no PR. <code>?</code> means wtree could not get its state.</dd></div>
            <div><dt>M @</dt><dd><code>M</code> marks the main worktree. <code>@</code> marks the worktree that holds the current directory, or the <code>-C &lt;dir&gt;</code> directory when you pass <code>-C</code>.</dd></div>
            <div><dt>* ↑</dt><dd><code>*</code> means uncommitted changes. <code>↑</code> means unpushed commits, which wtree counts only on branches with an upstream.</dd></div>
            <div><dt>[-]</dt><dd>A blocked row in the browser. <kbd>Space</kbd> cannot select it. The status line explains why and whether <kbd>f</kbd> can override the block.</dd></div>
            <div><dt>✓</dt><dd>The branch's commits are in the default branch. This check misses squash and rebase merges because they rewrite commits. Use the PR column for those.</dd></div>
            <div><dt>·</dt><dd>The path is the default location, <code>~/.wtree/&lt;repo&gt;/&lt;branch&gt;</code>.</dd></div>
          </dl>
        </UiCard>
      </section>
      <section aria-labelledby="cleanup-title">
        <h2 id="cleanup-title">Preview a cleanup, then run it</h2>
        <p class="section-intro">
          From a worktree you will keep, preview a cleanup based on PR state:
        </p>
        <UiCodeBlock
          code="wtree clean --done --dry-run"
          language="bash"
          variant="compact"
          :copyable="enhanced"
          :wrap="true"
        />
        <p class="section-intro">
          <code>--done</code> matches merged or closed pull requests.
        </p>
        <p class="section-intro">
          If the plan is correct, run the same cleanup without <code>--dry-run</code>:
        </p>
        <UiCodeBlock
          code="wtree clean --done"
          language="bash"
          variant="compact"
          :copyable="enhanced"
          :wrap="true"
        />
        <p class="section-intro">
          At the confirmation prompt, enter <code>y</code> to remove the planned worktrees.
          To remove just one by name, use <code>wtree rm &lt;branch-or-path&gt;</code>.
          It requires an exact match and follows the same confirmation and safety rules.
        </p>
      </section>
      <section aria-labelledby="shell-title">
        <h2 id="shell-title">Set up wt to change directory</h2>
        <p class="section-intro">
          wtree prints paths because a program cannot change its parent shell's directory.
          The <code>wt</code> shell function changes into the path that
          <code>go</code>, <code>new</code>, <code>path</code>, or <code>ui</code> prints.
        </p>
        <UiCommandList :items="shellCommands">
          <template #description="{ item }">
            <template v-if="item.command === 'wt go'">
              Pick a worktree or branch and change into its directory.
              <code>wt new</code> and <code>wt path</code> also change directory.
              In <code>wt ui</code>, press <kbd>o</kbd> to enter the focused worktree.
            </template>
            <template v-else>
              Run this line now to enable <code>wt</code> in this shell.
              Add the same line to <code>~/.zshrc</code> for future shells.
              For bash, replace <code>zsh</code> with <code>bash</code>.
              Add that line to <code>~/.bashrc</code>.
            </template>
          </template>
        </UiCommandList>
      </section>
      <section aria-labelledby="commands-title">
        <h2 id="commands-title">Commands</h2>
        <p class="section-intro">
          Repository commands use the Git repository in the current directory.
          Pass <code>-C &lt;dir&gt;</code> to use another one.
        </p>
        <UiCommandList :items="commands">
          <template #description="{ item }">
            <template v-if="item.command === 'wtree --size'">Measure disk usage with <code>du</code>. This is off by default because it is slow on large worktrees.</template>
            <template v-else>{{ item.description }}</template>
          </template>
        </UiCommandList>
      </section>
      <section aria-labelledby="keys-title">
        <h2 id="keys-title">Keys in wtree ui</h2>
        <p class="section-intro">Press <kbd>?</kbd> in the browser to see every shortcut.</p>
        <UiCommandList :items="keys" :copyable="false" command-header="Key">
          <template #command="{ item }"><kbd>{{ item.command }}</kbd></template>
        </UiCommandList>
      </section>
      <section aria-labelledby="limits-title">
        <h2 id="limits-title">Safety and exit codes</h2>
        <dl class="fg-site-definitions">
          <dt>Confirmation</dt>
          <dd><code>clean</code>, <code>rm</code>, and <code>prune</code> show a plan before asking for confirmation. <code>--yes</code> skips the question and runs the removal. <code>--dry-run</code> only prints the plan.</dd>
          <dt>Cleanup scope</dt>
          <dd><code>clean</code> needs a filter such as <code>--done</code> or <code>--older-than 30d</code>, or <code>--all</code> to consider every non-main worktree. Bare <code>wtree clean</code> tries to open the browser only when stdin and stdout are terminals and <code>--yes</code>, <code>--dry-run</code>, and <code>--json</code> are absent; see the <a href="https://github.com/filipgutica/wtree#readme">full reference</a> for details.</dd>
          <dt>Branches</dt>
          <dd>Branches stay by default. To request branch deletion, pass <code>--delete-branch</code> or turn it on with <kbd>b</kbd> in the browser.</dd>
          <dt>Protected worktrees</dt>
          <dd>The protected worktrees are the main worktree and the one that holds the current directory (or the <code>-C &lt;dir&gt;</code> directory). They are never removed, even with <code>--force</code>. Uncommitted changes, unpushed commits, and locks block removal unless you pass <code>--force</code> or select with <kbd>f</kbd>. Forced removal can discard uncommitted work.</dd>
          <dt>PR state</dt>
          <dd>PR state is cached for 10 minutes by default. <code>--refresh</code> bypasses the cache. Without a usable cache, missing, signed-out, or offline <code>gh</code> leaves PR state unknown. A cleanup that filters on PR state then exits 3 and removes nothing. It reports an error instead of reporting no matches.</dd>
          <dt>Pipes and scripts</dt>
          <dd>Without <code>--dry-run</code> or <code>--yes</code>, <code>clean</code>, <code>rm</code>, and <code>prune</code> print the plan and exit 2 when either stdin or stdout is not a terminal and there is something to remove. For <code>clean</code> and <code>rm</code>, <code>--json</code> also requires one of those flags when there is something to remove; see the <a href="https://github.com/filipgutica/wtree#readme">full reference</a> for script usage.</dd>
          <dt>Interactive browser</dt>
          <dd><code>wtree ui</code> requires terminals on stdin and stderr. If either is not a terminal, it exits 2 instead of starting. Stdout can be a pipe so the shell function can receive a path.</dd>
        </dl>
        <nav class="links" aria-label="Documentation">
          <a href="https://github.com/filipgutica/wtree#readme">Full reference</a>
          <a href="https://github.com/filipgutica/wtree#safety-rules">Safety rules</a>
        </nav>
      </section>
    </main>
    <footer class="fg-site-footer">
      <a href="https://github.com/filipgutica">Built by Filip Gutica</a>
      <nav aria-label="Project links">
        <a href="https://github.com/filipgutica/homebrew-tap">Homebrew tap</a>
        <a href="https://github.com/filipgutica/wtree/issues">Report an issue</a>
        <a href="https://github.com/filipgutica/wtree/releases">Releases</a>
      </nav>
    </footer>
  </div>
</template>
