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
  { label: 'Commands', href: '#commands-title' },
  { label: 'Keys in wtree ui', href: '#keys-title' },
  { label: 'Change directory', href: '#shell-title' },
  { label: 'Good to know', href: '#limits-title' },
] }];
const commands = [
  { command: 'wtree', description: 'List every worktree, with main first and the oldest next. Age counts from the last commit unless you pass --age-by checkout or --age-by created.' },
  { command: 'wtree ui', description: 'Browse, filter, and select worktrees, then remove them.' },
  { command: 'wtree clean --done --dry-run', description: 'Show which worktrees with merged or closed pull requests would be removed.' },
  { command: 'wtree new feat/example', description: 'Create a worktree for the branch, or print its path if it already has one.' },
  { command: 'wtree go', description: 'Pick a worktree or branch and print its path. A branch without a worktree gets one.' },
  { command: 'wtree --size' },
  { command: 'wtree --json', description: 'Print the list as JSON.' },
];
const keys = [
  { command: 'Space', description: 'Select the worktree. A blocked worktree stays unselected and says why.' },
  { command: 'f', description: 'Select a worktree that is blocked only by uncommitted changes, unpushed commits, or a lock.' },
  { command: 'Enter', description: 'Show the full branch name and path.' },
  { command: '/', description: 'Filter by branch or path.' },
  { command: 'd', description: 'Review the selected worktrees, then confirm to remove them.' },
  { command: 'o', description: "Quit and print the focused worktree's path." },
  { command: 'n', description: 'Create a worktree for a branch.' },
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
        <h1 id="title">List and clean up Git worktrees.</h1>
        <p class="lede">
          wtree is a terminal tool for Git worktrees, the extra folders where you
          check out other branches of the same repository. It shows each worktree's
          age and pull request state so you can find finished work and clean it up,
          and it creates new worktrees too.
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
              Homebrew also installs Node.js. wtree gets pull request state from
              the GitHub CLI, <code>gh</code>, and <code>wtree go</code> uses
              <code>fzf</code> for its picker if you have it.
              <a href="https://brew.sh/">Install Homebrew</a> if you don't have it.
            </p>
            <dl class="fg-site-facts">
              <div><dt>Runs on</dt><dd>macOS and Linux</dd></div>
              <div><dt>Needs</dt><dd>Git and Node.js 20+</dd></div>
              <div><dt>Source</dt><dd><a href="https://github.com/filipgutica/wtree">filipgutica/wtree</a></dd></div>
            </dl>
          </div>
        </div>
        <div class="capture" role="group" aria-label="wtree in use">
          <p class="fg-site-meta">To start, run <code>wtree ui</code> in your Git repository. The captures below use a demo repository and sample pull requests.</p>
          <UiCapture :items="captures" label="Steps">
            <template #caption="{ item }">
              <p v-if="item.id === 'browse'">
                <code>wtree ui</code> lists your worktrees in a table. Shortcuts sit
                above it, and details of the focused worktree sit below it.
              </p>
              <p v-else-if="item.id === 'select'">
                Press <kbd>Space</kbd> to select a worktree for removal. The selection
                count stays above the table, next to <kbd>d</kbd>, which opens the review.
              </p>
              <p v-else-if="item.id === 'review'">
                The review lists each worktree that will go. Press <kbd>y</kbd> to
                remove them. <kbd>b</kbd> turns branch deletion on or off.
              </p>
              <p v-else-if="item.id === 'list'">
                Plain <code>wtree</code> prints the same rows as a table. At a terminal, when pull
                requests are merged or closed or worktrees are prunable, it ends with a hint that names the command to run.
              </p>
              <p v-else-if="item.id === 'plan'">
                A dry run prints the cleanup plan for worktrees whose pull requests are
                merged or closed, and removes nothing.
              </p>
            </template>
          </UiCapture>
        </div>
        <UiCard title="On screen" title-tag="h3" class="legend">
          <dl class="fg-site-legend">
            <div><dt>[-]</dt><dd>Blocked, so <kbd>Space</kbd> won't select it. The status line says why, and whether <kbd>f</kbd> can force it.</dd></div>
            <div><dt>M @</dt><dd><code>M</code> marks the main worktree, and <code>@</code> the one you are in.</dd></div>
            <div><dt>* ↑</dt><dd><code>*</code> marks uncommitted changes, and <code>↑</code> unpushed commits.</dd></div>
            <div><dt>✓</dt><dd>The branch's commits are in the default branch. Squash and rebase merges rewrite those commits, so ✓ misses them. Trust the PR column instead.</dd></div>
            <div><dt>PR</dt><dd>The pull request is open, merged, or closed. <code>-</code> means there is none, and <code>?</code> means wtree couldn't get its state.</dd></div>
            <div><dt>·</dt><dd>The worktree is in its default folder, <code>~/.wtree/&lt;repo&gt;/&lt;branch&gt;</code>.</dd></div>
          </dl>
        </UiCard>
      </section>
      <section aria-labelledby="commands-title">
        <h2 id="commands-title">Commands</h2>
        <p class="section-intro">Commands work on the Git repository in the current directory. Pass <code>-C &lt;dir&gt;</code> to use another one.</p>
        <UiCommandList :items="commands">
          <template #description="{ item }">
            <template v-if="item.command === 'wtree --size'">Also measure each worktree's disk usage with <code>du</code>. It is off by default because it is slow on large worktrees.</template>
            <template v-else>{{ item.description }}</template>
          </template>
        </UiCommandList>
      </section>
      <section aria-labelledby="keys-title">
        <h2 id="keys-title">Keys in wtree ui</h2>
        <p class="section-intro">Press <kbd>?</kbd> in <code>wtree ui</code> to see every shortcut.</p>
        <UiCommandList :items="keys" :copyable="false" command-header="Key">
          <template #command="{ item }"><kbd>{{ item.command }}</kbd></template>
        </UiCommandList>
      </section>
      <section aria-labelledby="shell-title">
        <h2 id="shell-title">Change directory</h2>
        <p class="section-intro">
          A program can't change your shell's directory, so wtree prints paths instead.
          The <code>wt</code> shell function runs wtree and changes into the path it prints.
        </p>
        <UiCommandList :items="shellCommands">
          <template #description="{ item }">
            <template v-if="item.command === 'wt go'">
              Pick a worktree and change into it. <code>wt new</code>, <code>wt path</code>,
              and <code>wt ui</code> change directory too.
            </template>
            <template v-else>
              Run this line now to enable <code>wt</code>, and add it to <code>~/.zshrc</code> for new shells.
              For bash, write <code>bash</code> in place of <code>zsh</code> and use <code>~/.bashrc</code>.
            </template>
          </template>
        </UiCommandList>
      </section>
      <section aria-labelledby="limits-title">
        <h2 id="limits-title">Good to know</h2>
        <dl class="fg-site-definitions">
          <dt>Cleanup</dt>
          <dd>wtree removes nothing until you confirm the plan. <code>--yes</code> skips the question, and <code>--dry-run</code> only prints the plan. Branches stay unless you pass <code>--delete-branch</code> or press <kbd>b</kbd> in <code>wtree ui</code>.</dd>
          <dt>Protected</dt>
          <dd>wtree never removes the main worktree or the one you are in. Worktrees with uncommitted changes, unpushed commits, or a lock need <code>--force</code>. wtree counts unpushed commits only on branches that have an upstream.</dd>
          <dt>Unknown PR state</dt>
          <dd>wtree keeps pull request state in a cache for 10 minutes by default, and <code>--refresh</code> asks GitHub again. If the cache is stale and <code>gh</code> is missing, signed out, or offline, wtree has no pull request state. A cleanup that filters on it, such as <code>wtree clean --done</code>, then stops with an error instead of reporting no matches.</dd>
          <dt>Without a terminal</dt>
          <dd>When stdin or stdout is not a terminal, no one can answer the prompt. <code>clean</code>, <code>rm</code>, and <code>prune</code> then print the plan and exit 2 when there is something to remove, unless you pass <code>--dry-run</code> or <code>--yes</code>. <code>wtree ui</code> needs a terminal on stdin and stderr, and exits 2 without one.</dd>
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
