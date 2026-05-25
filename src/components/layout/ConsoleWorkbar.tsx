import { createContext, useContext, useEffect, type DependencyList, type ReactNode } from "react";

export interface ConsoleWorkbarRefreshAction {
  disabled?: boolean;
  isLoading?: boolean;
  label?: string;
  onClick: () => void;
}

export interface ConsoleWorkbarState {
  meta?: ReactNode;
  refresh?: ConsoleWorkbarRefreshAction;
  title: string;
}

export type ConsoleWorkbarSetter = (state: ConsoleWorkbarState | null) => void;

export const ConsoleWorkbarContext = createContext<ConsoleWorkbarSetter | null>(null);

export function useConsoleWorkbar(state: ConsoleWorkbarState, dependencies: DependencyList = [state]) {
  const setWorkbar = useContext(ConsoleWorkbarContext);

  useEffect(() => {
    setWorkbar?.(state);
    return () => setWorkbar?.(null);
  }, [setWorkbar, ...dependencies]);
}

export function useHasConsoleWorkbar(): boolean {
  return Boolean(useContext(ConsoleWorkbarContext));
}
