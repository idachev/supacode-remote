// Данните на mock Mac-овете за tools/mock-host.mjs: repository-та, worktree-та и табове.
// Отделно от сървъра, за да се сменят примерите, без да се чете логиката.

// ---- Данни за списъка: три repo-та, supacode с main + pinned + unpinned ----
// Празните незадължителни полета (`group`, `title`) се изпускат, както прави host-ът.

export const officeRepos = [
  {
    id: 'repo-supacode',
    name: 'supacode',
    worktrees: [
      {
        id: 'wt-main', name: 'main', branch: 'main', status: 'main', focused: false,
        working: false,
        tabs: [
          { id: 'tab-1', contentId: 'content-shell-main', title: 'zsh', focused: true, working: false,
            readOnly: false, agents: [] },
        ],
      },
      {
        id: 'wt-remote', name: 'remote-access', branch: 'remote-access', status: 'pinned', focused: true,
        title: 'Remote access', working: true,
        tabs: [
          { id: 'tab-2', contentId: 'content-claude', title: 'claude', focused: true, working: true,
            readOnly: false, agents: [{ agent: 'claude', activity: 'awaitingInput' }] },
          { id: 'tab-3', contentId: 'content-codex', title: 'codex review', focused: false, working: true,
            readOnly: false, agents: [{ agent: 'codex', activity: 'busy' }] },
        ],
      },
      {
        id: 'wt-picker', name: 'resume-picker', branch: 'feature/resume-picker', status: 'unpinned',
        focused: false, working: false,
        tabs: [
          { id: 'tab-4', contentId: 'content-idle', title: 'shell', focused: true, working: false,
            readOnly: false, agents: [{ agent: 'claude', activity: 'idle' }, { agent: 'codex', activity: 'error' }] },
          { id: 'tab-5', contentId: 'content-compact', title: 'compacting', focused: false, working: false,
            readOnly: true, agents: [{ agent: 'claude', activity: 'compacting' }] },
        ],
      },
    ],
  },
  {
    id: 'repo-notes',
    name: 'notes-app',
    group: 'Personal',
    worktrees: [
      {
        id: 'wt-notes-main', name: 'main', branch: 'main', status: 'main', focused: false,
        working: false,
        tabs: [
          { id: 'tab-6', contentId: 'content-notes', title: 'gradle', focused: true, working: false,
            readOnly: false, agents: [] },
        ],
      },
    ],
  },
  {
    id: 'repo-shop',
    name: 'web-shop',
    group: 'Work',
    worktrees: [
      {
        id: 'wt-shop-main', name: 'main', branch: 'main', status: 'main', focused: false,
        working: false,
        tabs: [
          { id: 'tab-7', contentId: 'content-shop-main', title: 'zsh', focused: true, working: false,
            readOnly: false, agents: [] },
        ],
      },
      {
        id: 'wt-shop-pin', name: 'billing', branch: 'feature/billing', status: 'pinned', focused: false,
        working: false,
        tabs: [
          { id: 'tab-8', contentId: 'content-shop-pin', title: 'claude', focused: true, working: false,
            readOnly: false, agents: [{ agent: 'claude', activity: 'idle' }] },
        ],
      },
    ],
  },
];

// Sidebar-ът на fork-а: Active (тече агент или script) над Pinned, после групите, после
// repository-тата без група. Вдигнатите в Active / Pinned редове ги няма в `rowIds`.
// MOCK_NO_SECTIONS=1 праща стария формат без `sections` и `rowIds`.
export const rowIds = {
  'repo-supacode': ['wt-main', 'wt-picker'],
  'repo-notes': ['wt-notes-main'],
  'repo-shop': ['wt-shop-main'],
};
export const sections = [
  { kind: 'active', title: 'Active', worktreeIds: ['wt-remote'] },
  { kind: 'pinned', title: 'Pinned', worktreeIds: ['wt-shop-pin'] },
  { kind: 'group', title: 'Work', collapsed: true, repositoryIds: ['repo-shop'] },
  { kind: 'group', title: 'Personal', repositoryIds: ['repo-notes'] },
  { kind: 'repository', repositoryId: 'repo-supacode' },
];

export const homeRepos = [
  {
    id: 'repo-dotfiles',
    name: 'dotfiles',
    worktrees: [
      {
        id: 'wt-dot-main', name: 'main', branch: 'main', status: 'main', focused: true, working: false,
        tabs: [
          { id: 'tab-h1', contentId: 'home-shell', title: 'zsh', focused: true, working: false,
            readOnly: false, agents: [] },
          { id: 'tab-h2', contentId: 'home-claude', title: 'claude', focused: false, working: true,
            readOnly: false, agents: [{ agent: 'claude', activity: 'busy' }] },
        ],
      },
    ],
  },
];
