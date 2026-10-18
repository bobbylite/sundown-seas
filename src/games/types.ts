export interface GameContext {
  /** Empty element the game fills; it is removed after dispose(). */
  root: HTMLElement;
  /** Return to the game selection page. */
  exit(): void;
}

export interface GameHandle {
  dispose(): void;
}

export type MountGame = (ctx: GameContext) => GameHandle;
