import { createContext, useContext, useState, useEffect } from "react";

const STORAGE_KEY = "signal-active-symbol";

interface ActiveSymbolCtx {
  activeSymbol: string | null;
  setActiveSymbol: (s: string | null) => void;
}

const ActiveSymbolContext = createContext<ActiveSymbolCtx>({
  activeSymbol: null,
  setActiveSymbol: () => {},
});

export function ActiveSymbolProvider({ children }: { children: React.ReactNode }) {
  const [activeSymbol, setActiveSymbolState] = useState<string | null>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) ?? "NVDA";
    } catch {
      return "NVDA";
    }
  });

  const setActiveSymbol = (s: string | null) => {
    setActiveSymbolState(s);
    try {
      if (s) localStorage.setItem(STORAGE_KEY, s);
    } catch {}
  };

  return (
    <ActiveSymbolContext.Provider value={{ activeSymbol, setActiveSymbol }}>
      {children}
    </ActiveSymbolContext.Provider>
  );
}

export function useActiveSymbol() {
  return useContext(ActiveSymbolContext);
}
