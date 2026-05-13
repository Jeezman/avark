import { createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { BootRoute } from "./routes/boot-route";
import { DashboardRoute } from "./routes/dashboard-route";
import { OnboardingRoute } from "./routes/onboarding-route";
import { TransactionsRoute } from "./routes/transactions-route";
import { SettingsRoute } from "./routes/settings-route";
import { CoinsRoute } from "./routes/coins-route";
import { SwapRoute } from "./routes/swap-route";
import { SwapCheckoutRoute } from "./routes/swap-checkout-route";
import { SwapHistoryRoute } from "./routes/swap-history-route";
import { RecoverLnRoute } from "./routes/recover-ln-route";
import { ProfileRoute } from "./routes/profile-route";
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

const coinsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/coins",
  component: CoinsRoute,
});

const settingsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/settings",
  component: SettingsRoute,
});

const swapRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/swap",
  component: SwapRoute,
});

const swapCheckoutRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/swap/checkout/$id",
  component: SwapCheckoutRoute,
});

const swapHistoryRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/swap/history",
  component: SwapHistoryRoute,
});

const recoverLnRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/recover/ln",
  component: RecoverLnRoute,
});

const profileRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/profile",
  component: ProfileRoute,
});

const routeTree = rootRoute.addChildren([
  bootRoute,
  onboardingRoute,
  appLayoutRoute.addChildren([
    dashboardRoute,
    transactionsRoute,
    coinsRoute,
    swapRoute,
    swapCheckoutRoute,
    swapHistoryRoute,
    recoverLnRoute,
    profileRoute,
    settingsRoute,
  ]),
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
