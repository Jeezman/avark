import { createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { BootRoute } from "./routes/boot-route";
import { DashboardRoute } from "./routes/dashboard-route";
import { OnboardingRoute } from "./routes/onboarding-route";

const rootRoute = createRootRoute();

const bootRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: BootRoute,
});

const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/onboarding",
  component: OnboardingRoute,
  async beforeLoad() {
    const exists = await invoke<boolean>("has_wallet");
    if (exists) {
      throw redirect({ to: "/", replace: true });
    }
  },
});

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dashboard",
  component: DashboardRoute,
  async beforeLoad() {
    const loaded = await invoke<boolean>("is_wallet_loaded");
    if (!loaded) {
      throw redirect({ to: "/", replace: true });
    }
  },
});

const routeTree = rootRoute.addChildren([bootRoute, onboardingRoute, dashboardRoute]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
