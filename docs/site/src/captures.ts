import browse from './captures/browse.html?raw';
import select from './captures/select.html?raw';
import review from './captures/review.html?raw';
import list from './captures/list.html?raw';
import plan from './captures/plan.html?raw';

export interface Capture {
  id: string;
  label: string;
  command: string;
  html: string;
}

export const captures: readonly Capture[] = [
  { id: 'browse', label: 'Browse', command: 'wtree ui', html: browse },
  { id: 'select', label: 'Select', command: 'Space', html: select },
  { id: 'review', label: 'Review', command: 'd', html: review },
  { id: 'list', label: 'List', command: 'wtree', html: list },
  {
    id: 'plan',
    label: 'Dry run',
    command: 'wtree clean --done --dry-run',
    html: plan,
  },
];
