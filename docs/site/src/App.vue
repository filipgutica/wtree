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
            List and clean up Git worktrees.
          </h1>
          <p class="lede">
            Adds age and pull request state to <code>git worktree list</code>.
            Review cleanup before removal.
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
            Homebrew installs Node.js. Optional: <code>gh</code> for PR state,
            <code>fzf</code> for <code>wtree go</code>.
            <a href="https://brew.sh/">Install Homebrew</a> if needed.
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
            Current wtree UI; demo repository and sample pull requests.
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
                <dd>Blocked; status explains why.</dd>
              </div>
              <div>
                <dt>M @</dt>
                <dd>Main / current worktree.</dd>
              </div>
              <div>
                <dt>* ↑</dt>
                <dd>Uncommitted changes / unpushed commits.</dd>
              </div>
              <div>
                <dt>✓</dt>
                <dd>
                  In default branch; misses squash/rebase merges. Trust PR state.
                </dd>
              </div>
              <div>
                <dt>PR</dt>
                <dd>
                  open, merged, closed; - none, ? unavailable.
                </dd>
              </div>
              <div>
                <dt>·</dt>
                <dd>
                  Default path: <code>~/.wtree/&lt;repo&gt;/&lt;branch&gt;</code>.
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
            Uses the current repository.
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
            <p>List: main first, then oldest.</p>
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
              Preview worktree removal for merged or closed PRs.
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
            <p>Create a branch's worktree or print its existing path.</p>
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
            <p>Pick a worktree or branch; print its path.</p>
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
              Measure disk usage with <code>du</code>; off by default.
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
            <p>List as JSON.</p>
          </li>
        </ul>
      </section>
      <section class="split narrow" aria-labelledby="keys-title">
        <header>
          <h2 id="keys-title">Keys in wtree ui</h2>
          <p><kbd>?</kbd> shows all shortcuts.</p>
        </header>
        <ul class="rows">
          <li class="row">
            <kbd>Space</kbd>
            <p>Select; blocked worktrees explain why they refuse.</p>
          </li>
          <li class="row">
            <kbd>Enter</kbd>
            <p>Full branch and path.</p>
          </li>
          <li class="row">
            <kbd>/</kbd>
            <p>Filter by branch or path.</p>
          </li>
          <li class="row">
            <kbd>d</kbd>
            <p>Review selected removals, then confirm.</p>
          </li>
          <li class="row">
            <kbd>o</kbd>
            <p>Exit; print the focused worktree's path.</p>
          </li>
          <li class="row">
            <kbd>n</kbd>
            <p>Create a branch's worktree.</p>
          </li>
        </ul>
      </section>
      <section class="split" aria-labelledby="shell-title">
        <header>
          <h2 id="shell-title">Change directory</h2>
          <p>
            The <code>wt</code> wrapper changes your shell's directory.
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
              Add to <code>~/.zshrc</code>; use <code>bash</code> for <code>~/.bashrc</code>.
            </p>
          </li>
          <li class="row">
            <code>wt go</code>
            <p>
              Pick and change directory. Also: <code>wt new</code>,
              <code>wt path</code>, <code>wt ui</code>.
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
            <strong>Cleanup:</strong> review the plan, then confirm. <code>--yes</code>
            skips confirmation; <code>--dry-run</code> never removes.
            Branch deletion requires <code>--delete-branch</code>.
          </p>
          <p>
            <strong>Protected:</strong> main and current worktrees are never removed.
            Dirty, unpushed, or locked worktrees require <code>--force</code>.
          </p>
          <p>
            <strong>Unknown PR state stops filtered cleanup.</strong>
            Missing, signed-out, or offline <code>gh</code> makes
            <code>wtree clean --done</code> fail, rather than report no matches.
          </p>
          <p>
            <strong>Without a terminal:</strong> <code>clean</code>, <code>rm</code>, and
            <code>prune</code> print the plan and exit 2 unless given
            <code>--dry-run</code> or <code>--yes</code>. <code>wtree ui</code> exits 2.
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
            <a href="https://github.com/filipgutica/homebrew-tap"
              >Homebrew tap</a
            >
          </p>
        </header>
        <ul class="rows narrow">
          <li class="row">
            <a href="https://filipgutica.github.io/annoterm/"
              ><code>annoterm</code></a
            >
            <p>
              Markdown review and agent feedback.
            </p>
          </li>
          <li class="row">
            <a href="https://filipgutica.github.io/devps/"
              ><code>devps</code></a
            >
            <p>
              Local dev server management.
            </p>
          </li>
          <li class="row">
            <a href="https://filipgutica.github.io/t3code/"
              ><code>Workbench</code></a
            >
            <p>
              Tickets and agent threads across repositories.
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
