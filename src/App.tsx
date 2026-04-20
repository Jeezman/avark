import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RouterProvider } from "@tanstack/react-router";
import { Toaster } from "sonner";
import { router } from "./router";
import { ThemeProvider, useTheme } from "./context/ThemeContext";
import { PinLockProvider } from "./context/PinLockContext";
import { FiatProvider } from "./context/FiatContext";
import "./App.css";

function AppInner() {
  const { theme } = useTheme();

  // Tell the Android system splash it can tear down now. This runs after
  // React has painted its first frame (useEffect fires post-commit), so the
  // orange splash stays visible through any JS bundle parse / ART GC stall.
  // No-op on non-Android platforms. See src-tauri/src/commands/splash.rs and
  // the Android MainActivity.kt for the coordination.
  useEffect(() => {
    invoke("splash_ready").catch(() => {
      // Kotlin-side failsafe will still dismiss the splash after the
      // timeout, so swallow this silently.
    });
  }, []);

  return (
    <>
      <Toaster theme={theme} position="top-center" richColors style={{ top: "env(safe-area-inset-top, 0px)" }} />
      <PinLockProvider>
        <FiatProvider>
          <RouterProvider router={router} />
        </FiatProvider>
      </PinLockProvider>
    </>
  );
}

function App() {
  return (
    <ThemeProvider>
      <AppInner />
    </ThemeProvider>
  );
}

export default App;
