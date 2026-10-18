import sunsetImg from './previews/sunset.jpg';
import montaukImg from './previews/montauk.jpg';
import { BEST_KEY } from '../games/montauk/rules';
import './menu.css';

export type GameId = 'sunset' | 'montauk';

interface Entry {
  id: GameId;
  title: string;
  pitch: string;
  tags: string[];
  play: string;
  img: string;
  alt: string;
}

const ENTRIES: Entry[] = [
  {
    id: 'sunset',
    title: 'Sunset Skipper',
    pitch: 'Trim a tiny toon sail across a glittering sunset sea, hop the swell and chase golden sun stars between palm islands.',
    tags: ['Sailing', 'Relaxed', 'Points of sail'],
    play: 'Set sail',
    img: sunsetImg,
    alt: 'A little red sailboat with a sun on its sail, crossing a sunset sea toward palm islands',
  },
  {
    id: 'montauk',
    title: 'Montauk Rips',
    pitch: 'Troll the rips off Montauk Point at sundown. Find the birds, fight stripers and bluefin on rod and reel, and keep the cockpit from flooding.',
    tags: ['Sportfishing', 'Take seas at 45°', 'Deck flooding'],
    play: 'Head out',
    img: montaukImg,
    alt: 'A white sportfisher with outriggers spread, trolling toward the Montauk Point lighthouse at sunset',
  },
];

function bestMontauk(): number {
  try { return Number(localStorage.getItem(BEST_KEY) || 0); } catch { return 0; }
}

const isIOS = (): boolean => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = (): boolean => matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** Render the game selection page into `root`; returns a cleanup function. */
export function mountMenu(root: HTMLElement, play: (id: GameId) => void): () => void {
  root.className = 'menu';
  const ac = new AbortController();
  const best = bestMontauk();
  root.innerHTML = `
    <div class="menu-sky" aria-hidden="true"><div class="menu-sun"></div><div class="menu-sea"></div></div>
    <main class="menu-inner">
      <header class="menu-head">
        <p class="menu-eyebrow">Two little boats · one big ocean</p>
        <h1>Sundown Seas</h1>
        <p class="menu-lede">Pick your water. Both games run on the same real-time ocean, with swells, foam and reflections all simulated on your GPU.</p>
      </header>
      <ul class="menu-games">
        ${ENTRIES.map(e => `
          <li>
            <a class="game-card" href="#${e.id}" data-id="${e.id}">
              <img src="${e.img}" alt="${e.alt}" width="960" height="570" loading="eager" decoding="async">
              <div class="game-info">
                <h2>${e.title}</h2>
                <p>${e.pitch}</p>
                <ul class="tags">${e.tags.map(t => `<li>${t}</li>`).join('')}</ul>
                <div class="game-foot">
                  <span class="play">${e.play}</span>
                  ${e.id === 'montauk' && best > 0 ? `<span class="best">Best score ${best.toLocaleString()}</span>` : ''}
                </div>
              </div>
            </a>
          </li>`).join('')}
      </ul>
      <footer class="menu-foot">
        <p class="ios-tip" hidden>On iPhone, tap Share then <b>Add to Home Screen</b> to play full screen.</p>
        <p>Plays best in landscape on phones. Keyboard on desktop, touch controls on phones and tablets.</p>
      </footer>
    </main>`;
  if (isIOS() && !isStandalone()) root.querySelector<HTMLElement>('.ios-tip')!.hidden = false;
  root.querySelectorAll<HTMLAnchorElement>('.game-card').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      play(a.dataset.id as GameId);
    }, { signal: ac.signal });
  });
  return () => {
    ac.abort();
    root.replaceChildren();
    root.className = '';
  };
}
