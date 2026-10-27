"use client";

/** The chat layout's sidebar state, for headers that need an "open sidebar" button. */
import { createContext, useContext } from "react";

export interface ShellState {
  collapsed: boolean;
  mobile: boolean;
  open: () => void;
}

export const ShellContext = createContext<ShellState>({ collapsed: false, mobile: false, open: () => undefined });

export function useShell(): ShellState {
  return useContext(ShellContext);
}
