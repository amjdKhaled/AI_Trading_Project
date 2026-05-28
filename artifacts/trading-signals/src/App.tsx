import { Switch, Route, Router as WouterRouter, Link, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import ChartPage from "@/pages/ChartPage";
import SignalsPage from "@/pages/SignalsPage";
import WatchlistPage from "@/pages/WatchlistPage";
import AiPage from "@/pages/AiPage";
import AiMemoryPage from "@/pages/AiMemoryPage";
import AiChartPage from "@/pages/AiChartPage";
import { ActiveSymbolProvider } from "@/lib/ActiveSymbolContext";
import { BarChart2, LineChart, ListOrdered, Activity, Brain, Database, Eye } from "lucide-react";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 10_000, retry: 1 },
  },
});

function TopNav() {
  const [location] = useLocation();
  const links = [
    { href: "/", label: "Chart", icon: <LineChart size={13} /> },
    { href: "/signals", label: "Signals", icon: <Activity size={13} /> },
    { href: "/watchlist", label: "Watchlist", icon: <ListOrdered size={13} /> },
    { href: "/ai", label: "AI Engine", icon: <Brain size={13} /> },
    { href: "/ai-memory", label: "AI Memory", icon: <Database size={13} /> },
    { href: "/ai-chart", label: "AI Chart", icon: <Eye size={13} /> },
  ];

  return (
    <nav className="flex items-center h-9 border-b border-border bg-sidebar px-3 flex-shrink-0">
      <div className="flex items-center gap-1.5 mr-5">
        <BarChart2 size={14} className="text-primary" />
        <span className="text-xs font-bold tracking-wide text-foreground">SIGNAL</span>
      </div>
      <div className="flex items-center gap-0.5">
        {links.map((l) => {
          const active = l.href === "/" ? location === "/" : location.startsWith(l.href);
          return (
            <Link
              key={l.href}
              href={l.href}
              data-testid={`nav-link-${l.label.toLowerCase()}`}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                active
                  ? "bg-sidebar-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-sidebar-accent/60"
              }`}
            >
              {l.icon}
              {l.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

function AppLayout() {
  return (
    <div className="flex flex-col h-full">
      <TopNav />
      <div className="flex-1 min-h-0 overflow-hidden">
        <Switch>
          <Route path="/" component={ChartPage} />
          <Route path="/signals" component={SignalsPage} />
          <Route path="/watchlist" component={WatchlistPage} />
          <Route path="/ai" component={AiPage} />
          <Route path="/ai-memory" component={AiMemoryPage} />
          <Route path="/ai-chart" component={AiChartPage} />
          <Route component={NotFound} />
        </Switch>
      </div>
    </div>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ActiveSymbolProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <AppLayout />
          </WouterRouter>
          <Toaster />
        </ActiveSymbolProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
