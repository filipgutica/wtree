<script setup lang="ts">
import { UiButton } from '@filipgutica/ui';
import type { Capture } from '../captures';
import CapturePreview from './CapturePreview.vue';

const { capture, enhanced } = defineProps<{
  capture: Capture;
  enhanced: boolean;
}>();
const emit = defineEmits<{
  (event: 'expand', capture: Capture, trigger: HTMLElement): void;
}>();
const expand = (event: MouseEvent) => {
  if (event.currentTarget instanceof HTMLElement)
    emit('expand', capture, event.currentTarget);
};
</script>

<template>
  <figure :id="`frame-${capture.id}`" class="frame" :data-tab="capture.label">
    <CapturePreview
      :html="capture.html"
      :label="`Terminal capture: ${capture.label}`"
      :fit="enhanced"
    />
    <figcaption class="frame-cap">
      <code>{{ capture.command }}</code>
      <p v-if="capture.id === 'browse'">
        Shortcuts sit above the table, with focused worktree details below it.
        <code>[-]</code> marks a worktree that cannot be removed.
      </p>
      <p v-else-if="capture.id === 'select'">
        Space selects a removable row. The selection count stays above the
        table, alongside <kbd>d</kbd> to review it.
      </p>
      <p v-else-if="capture.id === 'review'">
        The plan lists what will go. Nothing is removed until you press
        <kbd>y</kbd>. <kbd>b</kbd> also deletes the branches.
      </p>
      <p v-else-if="capture.id === 'list'">
        The same data as a plain table. It ends with a hint when there is
        something to clean up.
      </p>
      <p v-else-if="capture.id === 'plan'">
        Prints the cleanup plan for merged and closed pull requests. A dry run
        removes nothing.
      </p>
      <UiButton
        v-if="enhanced"
        variant="secondary"
        size="lg"
        class="capture-expand"
        :aria-label="`Expand ${capture.label} capture`"
        aria-haspopup="dialog"
        @click="expand"
        >Expand capture</UiButton
      >
    </figcaption>
  </figure>
</template>
