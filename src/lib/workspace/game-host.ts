export interface GameHostState {
  visited: boolean;
  lane: string;
  epoch: number;
}

export type GameHostEvent =
  | { type: "route"; pathname: string; lane: string }
  | { type: "lane"; lane: string };

export interface GameHostPresentation {
  mount: boolean;
  active: boolean;
  hidden: boolean;
  inert: boolean;
  paused: boolean;
  suspended: boolean;
  frameloop: "always" | "never";
}

export function initialGameHostState(pathname: string, lane: string): GameHostState {
  return { visited: pathname === "/game", lane, epoch: 0 };
}

export function reduceGameHostState(
  state: GameHostState,
  event: GameHostEvent,
): GameHostState {
  if (event.type === "lane") {
    return state.lane === event.lane
      ? state
      : { visited: false, lane: event.lane, epoch: state.epoch + 1 };
  }
  if (state.lane !== event.lane) {
    return {
      visited: event.pathname === "/game",
      lane: event.lane,
      epoch: state.epoch + 1,
    };
  }
  if (event.pathname === "/game" && !state.visited) {
    return { ...state, visited: true };
  }
  return state;
}

export function gameHostPresentation(
  state: GameHostState,
  pathname: string,
): GameHostPresentation {
  const active = state.visited && pathname === "/game";
  return {
    mount: state.visited,
    active,
    hidden: !active,
    inert: !active,
    paused: !active,
    suspended: !active,
    frameloop: active ? "always" : "never",
  };
}
