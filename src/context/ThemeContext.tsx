import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Theme = "dark" | "light";

const STORAGE_KEY = "avark-theme";

function readCachedTheme(): Theme {
  try {
    const cached = localStorage.getItem(STORAGE_KEY);
    if (cached === "light" || cached === "dark") return cached;
  } catch {
    // localStorage may be unavailable in some environments
  }
  return "dark";
}

// Apply synchronously before first paint to avoid FOUT
const initialTheme = readCachedTheme();
document.documentElement.setAttribute("data-theme", initialTheme);

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "dark",
  setTheme: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(initialTheme);
  const userSetRef = useRef(false);

  useLayoutEffect(() => {
    invoke<{ theme: string | null }>("settings")
      .then((s) => {
        if (userSetRef.current) return;
        if (s.theme === "light" || s.theme === "dark") {
          setThemeState(s.theme);
          document.documentElement.setAttribute("data-theme", s.theme);
          localStorage.setItem(STORAGE_KEY, s.theme);
        }
      })
      .catch(() => {});
  }, []);

  const setTheme = useCallback((newTheme: Theme) => {
    userSetRef.current = true;
    setThemeState(newTheme);
    document.documentElement.setAttribute("data-theme", newTheme);
    localStorage.setItem(STORAGE_KEY, newTheme);
    invoke("set_theme", { theme: newTheme }).catch(() => {});
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
