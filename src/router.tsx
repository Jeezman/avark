import { createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { BootRoute } from "./routes/boot-route";
import { DashboardRoute } from "./routes/dashboard-route";
import { OnboardingRoute } from "./routes/onboarding-route";
import { TransactionsRoute } from "./routes/transactions-route";
import { SettingsRoute } from "./routes/settings-route";
import { AppLayout } from "./components/AppLayout";

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

async function requireWallet() {
  const exists = await invoke<boolean>("has_wallet");
  if (!exists) {
    throw redirect({ to: "/", replace: true });
  }
}

const appLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app-layout",
  component: AppLayout,
  beforeLoad: requireWallet,
});

const dashboardRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/dashboard",
  component: DashboardRoute,
});

const transactionsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/transactions",
  component: TransactionsRoute,
});

const settingsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/settings",
  component: SettingsRoute,
});

const routeTree = rootRoute.addChildren([
  bootRoute,
  onboardingRoute,
  appLayoutRoute.addChildren([dashboardRoute, transactionsRoute, settingsRoute]),
]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
