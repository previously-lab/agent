import { createStore } from "zustand/vanilla";

export type AppState = {
  count: number;
};

export type AppActions = {
  decrementCount: () => void;
  incrementCount: () => void;
};

export type AppStore = AppState & AppActions;

export const defaultInitState: AppState = {
  count: 0,
};

export const createAppStore = (initState: AppState = defaultInitState) => {
  return createStore<AppStore>()((set) => ({
    ...initState,
    decrementCount: () => set((state) => ({ count: state.count - 1 })),
    incrementCount: () => set((state) => ({ count: state.count + 1 })),
  }));
};
