import { RouterProvider } from "@tanstack/react-router";
import { Toaster } from "sonner";
import { router } from "./router";
import "./App.css";

function App() {
  return (
    <>
      <Toaster theme="dark" position="top-center" richColors style={{ top: "env(safe-area-inset-top, 0px)" }} />
      <RouterProvider router={router} />
    </>
  );
}

export default App;
