<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { UiBadge, UiCard, UiCodeBlock } from '@filipgutica/ui';
import { UiCapture, UiCommandList, UiSiteHeader, UiSiteNav } from '@filipgutica/ui/site';
import { captures } from './captures';

const enhanced = ref(false);
onMounted(() => { enhanced.value = true; });

const sections = [{ items: [
  { label: 'Install', href: '#install' },
  { label: 'Commands', href: '#commands-title' },
  { label: 'Keys in wtree ui', href: '#keys-title' },
  { label: 'Change directory', href: '#shell-title' },
  { label: 'Good to know', href: '#limits-title' },
] }];
const commands = [
  { command: 'wtree', description: 'List: main first, then oldest.' },
  { command: 'wtree ui', description: 'Browse, filter, select, and remove worktrees.' },
  { command: 'wtree clean --done --dry-run', description: 'Preview worktree removal for merged or closed PRs.' },
  { command: 'wtree new feat/example', description: "Create a branch's worktree or print its existing path." },
  { command: 'wtree go', description: 'Pick a worktree or branch; print its path.' },
  { command: 'wtree --size' },
  { command: 'wtree --json', description: 'List as JSON.' },
];
const keys = [
  { command: 'Space', description: 'Select; blocked worktrees explain why they refuse.' },
  { command: 'Enter', description: 'Full branch and path.' },
  { command: '/', description: 'Filter by branch or path.' },
  { command: 'd', description: 'Review selected removals, then confirm.' },
  { command: 'o', description: "Exit; print the focused worktree's path." },
  { command: 'n', description: "Create a branch's worktree." },
];
const shellCommands = [
  { command: 'eval "$(wtree shell-init zsh)"' },
  { command: 'wt go' },
];
</script>

<template>
  <a class="fg-site-skip" href="#main">Skip to content</a>
  <div class="page" :data-enhanced="enhanced">
    <UiSiteHeader
      class="page-header"
      project="wtree"
      :links="[
        { label: 'Guide', href: 'https://github.com/filipgutica/wtree/blob/main/README.md' },
        { label: 'GitHub', href: 'https://github.com/filipgutica/wtree' },
        { label: 'Releases', href: 'https://github.com/filipgutica/wtree/releases' },
      ]"
    />
    <UiSiteNav label="On this page" :groups="sections" />
    <main id="main">
      <section class="intro" aria-labelledby="title">
        <h1 id="title">List and clean up Git worktrees.</h1>
        <p class="lede">
          Adds age and pull request state to <code>git worktree list</code>.
          Review cleanup before removal.
        </p>
        <div id="install" class="install">
          <p class="hint">Install with Homebrew</p>
          <UiCodeBlock
            code="brew install filipgutica/tap/wtree"
            language="bash"
            variant="compact"
            :copyable="enhanced"
            :wrap="true"
          />
          <div class="meta">
            <p class="hint">
              Homebrew installs Node.js. Optional: <code>gh</code> for PR state,
              <code>fzf</code> for <code>wtree go</code>.
              <a href="https://brew.sh/">Install Homebrew</a> if needed.
            </p>
            <dl class="fg-site-facts">
              <div><dt>Runs on</dt><dd>macOS and Linux</dd></div>
              <div><dt>Needs</dt><dd>Git and Node.js 20+</dd></div>
              <div><dt>Source</dt><dd><a href="https://github.com/filipgutica/wtree">filipgutica/wtree</a></dd></div>
            </dl>
          </div>
        </div>
        <div class="capture" role="group" aria-label="wtree in use">
          <p class="hint">Current wtree UI; demo repository and sample pull requests.</p>
          <UiCapture :items="captures" label="Steps">
            <template #caption="{ item }">
              <p v-if="item.id === 'browse'">
                Shortcuts sit above the table, with focused worktree details below it.
                <code>[-]</code> marks a worktree that cannot be removed.
              </p>
              <p v-else-if="item.id === 'select'">
                Space selects a removable row. The selection count stays above the
                table, alongside <kbd>d</kbd> to review it.
              </p>
              <p v-else-if="item.id === 'review'">
                The plan lists what will go. Nothing is removed until you press
                <kbd>y</kbd>. <kbd>b</kbd> also deletes the branches.
              </p>
              <p v-else-if="item.id === 'list'">
                The same data as a plain table. It ends with a hint when there is
                something to clean up.
              </p>
              <p v-else-if="item.id === 'plan'">
                Prints the cleanup plan for merged and closed pull requests. A dry run
                removes nothing.
              </p>
            </template>
          </UiCapture>
        </div>
        <UiCard title="On screen" title-tag="h3" class="legend">
          <dl class="legend-grid">
            <div><dt><UiBadge>[-]</UiBadge></dt><dd>Blocked; status explains why.</dd></div>
            <div><dt><UiBadge>M @</UiBadge></dt><dd>Main / current worktree.</dd></div>
            <div><dt><UiBadge>* ↑</UiBadge></dt><dd>Uncommitted changes / unpushed commits.</dd></div>
            <div><dt><UiBadge>✓</UiBadge></dt><dd>In default branch; misses squash/rebase merges. Trust PR state.</dd></div>
            <div><dt><UiBadge>PR</UiBadge></dt><dd>open, merged, closed; - none, ? unavailable.</dd></div>
            <div><dt><UiBadge>·</UiBadge></dt><dd>Default path: <code>~/.wtree/&lt;repo&gt;/&lt;branch&gt;</code>.</dd></div>
          </dl>
        </UiCard>
      </section>
      <section aria-labelledby="commands-title">
        <h2 id="commands-title">Commands</h2>
        <p class="section-intro">Uses the current repository.</p>
        <UiCommandList :items="commands">
          <template #description="{ item }">
            <template v-if="item.command === 'wtree --size'">Measure disk usage with <code>du</code>; off by default.</template>
            <template v-else>{{ item.description }}</template>
          </template>
        </UiCommandList>
      </section>
      <section aria-labelledby="keys-title">
        <h2 id="keys-title">Keys in wtree ui</h2>
        <p class="section-intro"><kbd>?</kbd> shows all shortcuts.</p>
        <UiCommandList :items="keys" :copyable="false" command-header="Key">
          <template #command="{ item }"><kbd>{{ item.command }}</kbd></template>
        </UiCommandList>
      </section>
      <section aria-labelledby="shell-title">
        <h2 id="shell-title">Change directory</h2>
        <p class="section-intro">The <code>wt</code> wrapper changes your shell's directory.</p>
        <UiCommandList :items="shellCommands">
          <template #description="{ item }">
            <template v-if="item.command === 'wt go'">
              Pick and change directory. Also: <code>wt new</code>, <code>wt path</code>, <code>wt ui</code>.
            </template>
            <template v-else>
              Add to <code>~/.zshrc</code>; use <code>bash</code> for <code>~/.bashrc</code>.
            </template>
          </template>
        </UiCommandList>
      </section>
      <section aria-labelledby="limits-title">
        <h2 id="limits-title">Good to know</h2>
        <dl class="fg-site-definitions">
          <dt>Cleanup</dt>
          <dd>Review the plan, then confirm. <code>--yes</code> skips confirmation; <code>--dry-run</code> never removes. Branch deletion requires <code>--delete-branch</code>.</dd>
          <dt>Protected</dt>
          <dd>Main and current worktrees are never removed. Dirty, unpushed, or locked worktrees require <code>--force</code>.</dd>
          <dt>Unknown PR state</dt>
          <dd>Stops filtered cleanup. Missing, signed-out, or offline <code>gh</code> makes <code>wtree clean --done</code> fail, rather than report no matches.</dd>
          <dt>Without a terminal</dt>
          <dd><code>clean</code>, <code>rm</code>, and <code>prune</code> print the plan and exit 2 unless given <code>--dry-run</code> or <code>--yes</code>. <code>wtree ui</code> exits 2.</dd>
        </dl>
        <nav class="links" aria-label="Documentation">
          <a href="https://github.com/filipgutica/wtree#readme">Full reference</a>
          <a href="https://github.com/filipgutica/wtree#safety-rules">Safety rules</a>
        </nav>
      </section>
    </main>
    <footer class="page-footer">
      <a href="https://github.com/filipgutica">Built by Filip Gutica</a>
      <nav aria-label="Project links">
        <a href="https://github.com/filipgutica/homebrew-tap">Homebrew tap</a>
        <a href="https://github.com/filipgutica/wtree/issues">Report an issue</a>
        <a href="https://github.com/filipgutica/wtree/releases">Releases</a>
      </nav>
    </footer>
  </div>
</template>
