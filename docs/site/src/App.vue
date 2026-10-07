<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, useTemplateRef } from 'vue';
import { UiButton, UiCodeBlock, UiDialog, UiTabs } from '@filipgutica/ui';
import SiteNavigation from './components/SiteNavigation.vue';
import CaptureFigure from './components/CaptureFigure.vue';
import CapturePreview from './components/CapturePreview.vue';
import { captures, type Capture } from './captures';
import { useScrollReveal } from './composables/useScrollReveal';

const main = useTemplateRef<HTMLElement>('main');
useScrollReveal(main);

const enhanced = ref(false);
const activeCapture = ref('browse');
const shellSetup = 'eval "$(wtree shell-init zsh)"';
const captureTabs = captures.map(({ id, label }) => ({ value: id, label }));
const captureOpen = ref(false);
const viewedCapture = ref<Capture>();
let captureTrigger: HTMLElement | undefined;
let firstFrame = 0;
let secondFrame = 0;

const openCapture = (capture: Capture, trigger: HTMLElement) => {
  viewedCapture.value = capture;
  captureTrigger = trigger;
  captureOpen.value = true;
};
const restoreCaptureFocus = (event: Event) => {
  if (!captureTrigger?.isConnected) return;
  event.preventDefault();
  captureTrigger.focus({ preventScroll: true });
};
const currentHashTarget = () => {
  try {
    return document.getElementById(decodeURIComponent(location.hash.slice(1)));
  } catch {
    return null;
  }
};
const alignCurrentHash = async () => {
  await nextTick();
  cancelAnimationFrame(firstFrame);
  cancelAnimationFrame(secondFrame);
  firstFrame = requestAnimationFrame(() => {
    secondFrame = requestAnimationFrame(() =>
      currentHashTarget()?.scrollIntoView({
        behavior: 'instant',
        block: 'start',
      }),
    );
  });
};
const selectHashCapture = () => {
  const target = currentHashTarget();
  const capture = captures.find(({ id }) => target?.closest(`#frame-${id}`));
  if (!capture || activeCapture.value === capture.id) return false;
  activeCapture.value = capture.id;
  return true;
};
const onHashChange = () => {
  if (selectHashCapture()) void alignCurrentHash();
};
onMounted(() => {
  enhanced.value = true;
  selectHashCapture();
  // Hydration hides inactive captures. Realign a deep link after preview sizing settles.
  if (location.hash) void alignCurrentHash();
  window.addEventListener('hashchange', onHashChange);
  window.addEventListener('popstate', onHashChange);
});
onUnmounted(() => {
  cancelAnimationFrame(firstFrame);
  cancelAnimationFrame(secondFrame);
  window.removeEventListener('hashchange', onHashChange);
  window.removeEventListener('popstate', onHashChange);
});
</script>

<template>
  <a class="skip" href="#main">Skip to content</a>
  <div class="page" :data-enhanced="enhanced">
    <SiteNavigation />
    <header class="page-header">
      <a class="page-brand" href="/wtree/" aria-label="wtree home">wtree</a>
      <nav aria-label="Main navigation">
        <a href="https://github.com/filipgutica/wtree/blob/main/README.md">Guide</a>
        <a href="https://github.com/filipgutica/wtree">GitHub</a>
        <a href="https://github.com/filipgutica/wtree/releases">Releases</a>
      </nav>
    </header>
    <main id="main" ref="main">
      <div>
        <section class="hero" aria-labelledby="title">
          <h1 id="title" class="tagline">
            Which worktrees are still in use, and which can go.
          </h1>
          <p class="lede">
            wtree adds age, pull request state, and safe cleanup to
            <code>git worktree list</code>. You review the plan before anything
            is removed.
          </p>
          <div id="install" class="install-command">
            <p class="hint">Install with Homebrew</p>
            <UiCodeBlock
              code="brew install filipgutica/tap/wtree"
              language="bash"
              variant="compact"
              :copyable="enhanced"
              :wrap="true"
            />
          </div>
          <p class="hint">
            Homebrew installs Node.js. GitHub CLI (<code>gh</code>) is optional
            for pull request state, and <code>fzf</code> is optional for
            <code>wtree go</code>. New to Homebrew?
            <a href="https://brew.sh/">Install it first</a>.
          </p>
          <dl class="facts">
            <div>
              <dt>Runs on</dt>
              <dd>macOS and Linux</dd>
            </div>
            <div>
              <dt>Needs</dt>
              <dd>Git and Node.js 20+</dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>
                <a href="https://github.com/filipgutica/wtree"
                  >filipgutica/wtree</a
                >
              </dd>
            </div>
          </dl>
        </section>
        <section class="stage" aria-label="wtree in use">
          <p class="stage-label">
            Demo repository with sample pull requests. Captured from the current
            wtree UI.
          </p>
          <UiTabs v-model="activeCapture" :items="captureTabs" label="Steps">
            <template #panel="{ value }">
              <template v-for="capture in captures" :key="capture.id">
                <CaptureFigure
                  v-if="capture.id === value"
                  :capture="capture"
                  :enhanced="enhanced"
                  @expand="openCapture"
                />
              </template>
            </template>
          </UiTabs>
          <aside class="legend" aria-labelledby="legend-title">
            <h3 id="legend-title">On screen</h3>
            <dl style="--cols: 3">
              <div>
                <dt>[-]</dt>
                <dd>Blocked. The status line says why.</dd>
              </div>
              <div>
                <dt>M @</dt>
                <dd>M is the main worktree. @ is the one you are in.</dd>
              </div>
              <div>
                <dt>* ↑</dt>
                <dd>Uncommitted changes, or commits not pushed yet.</dd>
              </div>
              <div>
                <dt>✓</dt>
                <dd>
                  Merged into the default branch. Squash and rebase merges do
                  not show it, so trust the PR column.
                </dd>
              </div>
              <div>
                <dt>PR</dt>
                <dd>
                  open, merged, closed, or - for none. ? means GitHub state is
                  unavailable.
                </dd>
              </div>
              <div>
                <dt>·</dt>
                <dd>
                  The path is the default,
                  <code>~/.wtree/&lt;repo&gt;/&lt;branch&gt;</code>.
                </dd>
              </div>
            </dl>
          </aside>
        </section>
      </div>
      <section class="split" aria-labelledby="commands-title">
        <header>
          <h2 id="commands-title">Commands</h2>
          <p>
            The list is for the repository you are in. Cleanup asks before it
            removes anything.
          </p>
        </header>
        <ul class="rows">
          <li class="row">
            <div class="cmd">
              <UiCodeBlock
                variant="compact"
                code="wtree"
                language="bash"
                :copyable="enhanced"
                :wrap="true"
              />
            </div>
            <p>List worktrees, oldest first after the main one.</p>
          </li>
          <li class="row">
            <div class="cmd">
              <UiCodeBlock
                variant="compact"
                code="wtree ui"
                language="bash"
                :copyable="enhanced"
                :wrap="true"
              />
            </div>
            <p>Browse, filter, select, and remove worktrees.</p>
          </li>
          <li class="row">
            <div class="cmd">
              <UiCodeBlock
                variant="compact"
                code="wtree clean --done --dry-run"
                language="bash"
                :copyable="enhanced"
                :wrap="true"
              />
            </div>
            <p>
              Preview removing worktrees whose pull request is merged or closed.
            </p>
          </li>
          <li class="row">
            <div class="cmd">
              <UiCodeBlock
                variant="compact"
                code="wtree new feat/example"
                language="bash"
                :copyable="enhanced"
                :wrap="true"
              />
            </div>
            <p>Create a worktree for a branch, or print the existing path.</p>
          </li>
          <li class="row">
            <div class="cmd">
              <UiCodeBlock
                variant="compact"
                code="wtree go"
                language="bash"
                :copyable="enhanced"
                :wrap="true"
              />
            </div>
            <p>Pick a worktree or branch and print its path.</p>
          </li>
          <li class="row">
            <div class="cmd">
              <UiCodeBlock
                variant="compact"
                code="wtree --size"
                language="bash"
                :copyable="enhanced"
                :wrap="true"
              />
            </div>
            <p>
              Measure disk usage with <code>du</code>. It is off by default.
            </p>
          </li>
          <li class="row">
            <div class="cmd">
              <UiCodeBlock
                variant="compact"
                code="wtree --json"
                language="bash"
                :copyable="enhanced"
                :wrap="true"
              />
            </div>
            <p>Read the list as JSON.</p>
          </li>
        </ul>
      </section>
      <section class="split narrow" aria-labelledby="keys-title">
        <header>
          <h2 id="keys-title">Keys in wtree ui</h2>
          <p>Press <kbd>?</kbd> in the app for the full list.</p>
        </header>
        <ul class="rows">
          <li class="row">
            <kbd>Space</kbd>
            <p>Select a worktree. Blocked ones refuse and say why.</p>
          </li>
          <li class="row">
            <kbd>Enter</kbd>
            <p>Show the full branch and path.</p>
          </li>
          <li class="row">
            <kbd>/</kbd>
            <p>Filter by branch or path.</p>
          </li>
          <li class="row">
            <kbd>d</kbd>
            <p>Review removal of the selection, then confirm.</p>
          </li>
          <li class="row">
            <kbd>o</kbd>
            <p>Exit and print the focused worktree's path.</p>
          </li>
          <li class="row">
            <kbd>n</kbd>
            <p>Create a worktree for a branch.</p>
          </li>
        </ul>
      </section>
      <section class="split" aria-labelledby="shell-title">
        <header>
          <h2 id="shell-title">Change directory</h2>
          <p>
            A program cannot change its parent shell's directory, so wtree ships
            a small wrapper.
          </p>
        </header>
        <ul class="rows">
          <li class="row">
            <div class="cmd">
              <UiCodeBlock
                variant="compact"
                :code="shellSetup"
                language="bash"
                :copyable="enhanced"
                :wrap="true"
              />
            </div>
            <p>
              Add this to <code>~/.zshrc</code>. Use <code>bash</code> for
              <code>~/.bashrc</code>.
            </p>
          </li>
          <li class="row">
            <code>wt go</code>
            <p>
              Pick a worktree, then change into it. <code>wt new</code>,
              <code>wt path</code>, and <code>wt ui</code> work the same way.
            </p>
          </li>
        </ul>
      </section>
      <section class="split" aria-labelledby="limits-title">
        <header>
          <h2 id="limits-title">Good to know</h2>
        </header>
        <div class="text-rows">
          <p>
            <strong>Cleanup asks first.</strong> It prints the plan and waits
            for your confirmation. <code>--yes</code> skips the prompt, and
            <code>--dry-run</code> never removes. Branches are deleted only with
            <code>--delete-branch</code>.
          </p>
          <p>
            <strong>Blocked worktrees stay put.</strong> Main and current
            worktrees are never removed. Dirty, unpushed, and locked ones need
            <code>--force</code>.
          </p>
          <p>
            <strong
              >Unknown pull request state stops a filtered cleanup.</strong
            >
            If <code>gh</code> is missing, signed out, or offline,
            <code>wtree clean --done</code> exits with an error and does not
            report an empty result.
          </p>
          <p>
            <strong>Scripts and agents never hang.</strong> Without a terminal,
            <code>clean</code>, <code>rm</code>, and <code>prune</code> print
            the plan and exit with code 2 unless you pass
            <code>--dry-run</code> or <code>--yes</code>.
            <code>wtree ui</code> also exits with code 2.
          </p>
          <nav class="links" aria-label="Documentation">
            <a href="https://github.com/filipgutica/wtree#readme"
              >Full reference</a
            >
            <a href="https://github.com/filipgutica/wtree#safety-rules"
              >Safety rules</a
            >
          </nav>
        </div>
      </section>
      <section class="split" aria-labelledby="family-title">
        <header>
          <h2 id="family-title">Also from Filip</h2>
          <p>
            The three terminal tools install from
            <a href="https://github.com/filipgutica/homebrew-tap"
              >one Homebrew tap</a
            >.
          </p>
        </header>
        <ul class="rows narrow">
          <li class="row">
            <a href="https://filipgutica.github.io/annoterm/"
              ><code>annoterm</code></a
            >
            <p>
              Review Markdown in the terminal and send your comments to a coding
              agent as precise feedback.
            </p>
          </li>
          <li class="row">
            <a href="https://filipgutica.github.io/devps/"
              ><code>devps</code></a
            >
            <p>
              Manage local dev servers: see what started each one, jump back to
              it, or stop it.
            </p>
          </li>
          <li class="row">
            <a href="https://filipgutica.github.io/t3code/"
              ><code>Workbench</code></a
            >
            <p>
              Plan across repositories, organize tickets, and start agent
              threads in worktrees.
            </p>
          </li>
        </ul>
      </section>
    </main>
    <footer>
      <a href="https://github.com/filipgutica">Built by Filip Gutica</a>
      <nav aria-label="Project links">
        <a href="https://github.com/filipgutica/wtree/issues"
          >Report an issue</a
        >
        <a href="https://github.com/filipgutica/wtree/releases">Releases</a>
      </nav>
    </footer>
  </div>
  <UiDialog
    v-model:open="captureOpen"
    :title="`${viewedCapture?.label ?? ''} capture`"
    description="Scroll to read the full capture."
    class="capture-viewer"
    @close-auto-focus="restoreCaptureFocus"
  >
    <CapturePreview
      v-if="viewedCapture"
      :html="viewedCapture.html"
      :label="`${viewedCapture.label} capture at full size`"
      :fit="false"
    />
    <template #footer
      ><UiButton variant="secondary" size="lg" @click="captureOpen = false"
        >Close capture</UiButton
      ></template
    >
  </UiDialog>
</template>
