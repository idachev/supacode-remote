// „Нов worktree“ (ЗД11): бутонът „+“ на repository-то отваря този диалог, както бутонът на всяко
// repository в Supacode. Заявката и отговорът са в app.js; тук са полето, подсказките и
// състоянието „Създавам…“.

import { $ } from './dom.js';
import { ui } from './ui-state.js';
import { existingNames, worktreeNameHint } from './worktree-name.js';

let submit = () => {};

export function initWorktreeDialog(onSubmit) {
  submit = onSubmit;
  $('worktree-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const d = ui.newWorktree;
    if (!d || d.ref || hint(d)) return;
    submit(d);
  });
  $('worktree-name').addEventListener('input', () => {
    if (!ui.newWorktree || ui.newWorktree.ref) return;
    ui.newWorktree.name = $('worktree-name').value;
    ui.newWorktree.error = null;
    renderWorktreeDialog();
  });
  $('worktree-cancel').addEventListener('click', closeWorktreeDialog);
  $('worktree').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeWorktreeDialog();
  });
}

function hint(d) {
  return worktreeNameHint(d.name, existingNames(ui.list, d.repositoryId));
}

export function openWorktreeDialog(repository) {
  if (ui.newWorktree?.ref) return;
  ui.newWorktree = { repositoryId: repository.id, repositoryName: repository.name, name: '', error: null, ref: null };
  $('worktree-name').value = '';
  $('worktree').hidden = false;
  renderWorktreeDialog();
  $('worktree-name').focus();
}

/**
 * Затварянето само спира чакането тук: Mac-ът продължава да създава, а готовото worktree идва
 * със следващия `list`.
 */
export function closeWorktreeDialog() {
  ui.newWorktree = null;
  $('worktree').hidden = true;
}

export function renderWorktreeDialog() {
  const d = ui.newWorktree;
  if (!d) return;
  $('worktree-title').textContent = `Нов worktree в ${d.repositoryName}`;
  const busy = d.ref != null;
  const problem = d.name.trim() ? hint(d) : null;
  $('worktree-name').disabled = busy;
  $('worktree-hint').textContent = problem ?? '';
  $('worktree-hint').hidden = !problem;
  $('worktree-error').textContent = d.error ?? '';
  $('worktree-error').hidden = !d.error;
  $('worktree-create').disabled = busy || hint(d) != null || ui.state?.hostSession == null;
  $('worktree-create').textContent = busy ? 'Създавам…' : 'Създай';
  $('worktree-cancel').textContent = busy ? 'Не чакай' : 'Затвори';
}
