import { RouterProvider } from "@tanstack/react-router";
import { Toaster } from "sonner";
import { router } from "./router";
import { ThemeProvider, useTheme } from "./context/ThemeContext";
import "./App.css";

function AppInner() {
  const { theme } = useTheme();
  return (
    <>
      <Toaster theme={theme} position="top-center" richColors style={{ top: "env(safe-area-inset-top, 0px)" }} />
      <RouterProvider router={router} />
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
