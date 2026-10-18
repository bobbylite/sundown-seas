// Single-page shell: a game selection page plus the two games, routed by URL hash (#sunset, #montauk) so it
// works from any static host path, including GitHub Pages project sites.
import '@fontsource/grandstander/700.css';
import '@fontsource/grandstander/900.css';
import '@fontsource/baloo-2/500.css';
import '@fontsource/baloo-2/700.css';
import './styles/base.css';
import { mountMenu, type GameId } from './menu/menu';
import type { MountGame } from './games/types';

const GAMES: Record<GameId, { title: string; load: () => Promise<{ mount: MountGame }> }> = {
  sunset: { title: 'Sunset Skipper', load: () => import('./games/sunset/sunset') },
  montauk: { title: 'Montauk Rips', load: () => import('./games/montauk/montauk') },
};
const APP_TITLE = 'Sundown Seas';

const app = document.getElementById('app')!;
let current: { id: GameId | 'menu'; dispose(): void } | null = null;
let routeToken = 0;

function hasWebGL2(): boolean {
  try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; }
}

function fatal(view: HTMLElement, title: string, text: string): void {
  view.className = 'fatal';
  view.innerHTML = '<div><h2></h2><p></p><button type="button">Back to the games</button></div>';
  view.querySelector('h2')!.textContent = title;
  view.querySelector('p')!.textContent = text;
  view.querySelector('button')!.addEventListener('click', () => go('menu'));
}

function targetFromHash(): GameId | 'menu' {
  const id = location.hash.replace(/^#\/?/, '');
  return id in GAMES ? (id as GameId) : 'menu';
}

async function route(): Promise<void> {
  const target = targetFromHash();
  if (current?.id === target) return;
  const token = ++routeToken;
  current?.dispose();
  current = null;
  app.replaceChildren();
  const view = document.createElement('div');
  app.append(view);

  if (target === 'menu') {
    document.title = APP_TITLE;
    current = { id: 'menu', dispose: mountMenu(view, id => go(id)) };
    return;
  }
  const game = GAMES[target];
  document.title = `${game.title} · ${APP_TITLE}`;
  if (!hasWebGL2()) {
    fatal(view, 'WebGL 2 is not available', 'This browser cannot run the ocean renderer. Try a recent Safari, Chrome, Edge or Firefox.');
    return;
  }
  view.className = 'loading';
  view.textContent = `Loading ${game.title}…`;
  current = { id: target, dispose: () => {} };
  try {
    const mod = await game.load();
    if (token !== routeToken) return;
    view.className = '';
    view.textContent = '';
    const handle = mod.mount({ root: view, exit: () => go('menu') });
    current = { id: target, dispose: () => handle.dispose() };
  } catch (err) {
    if (token !== routeToken) return;
    console.error(err);
    fatal(view, `${game.title} could not start`, 'Something went wrong while loading the game. Check your connection and try again.');
  }
}

function go(id: GameId | 'menu'): void {
  const hash = id === 'menu' ? '' : `#${id}`;
  if (location.hash !== hash) history.pushState(null, '', hash || location.pathname + location.search);
  void route();
}

addEventListener('popstate', () => void route());
addEventListener('hashchange', () => void route());
void route();
