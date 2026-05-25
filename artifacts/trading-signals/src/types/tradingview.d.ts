// Minimal ambient declarations for the TradingView Charting Library global.
// The full type defs ship inside the licensed bundle (charting_library.d.ts);
// we only stub what TVChartContainer.tsx actually touches so the project
// typechecks even when the library files aren't installed yet.

declare global {
  interface Window {
    TradingView?: {
      widget: new (options: TVWidgetOptions) => TVWidget;
      version?: () => string;
    };
  }
}

export interface TVWidgetOptions {
  container:        HTMLElement | string;
  library_path:     string;
  symbol:           string;
  interval:         string;
  datafeed:         unknown;
  locale?:          string;
  timezone?:        string;
  theme?:           "Light" | "Dark";
  autosize?:        boolean;
  fullscreen?:      boolean;
  disabled_features?: string[];
  enabled_features?:  string[];
  overrides?:       Record<string, unknown>;
  loading_screen?:  { backgroundColor?: string; foregroundColor?: string };
  custom_css_url?:  string;
  toolbar_bg?:      string;
}

export interface TVShape {
  id?: string;
}

export interface TVChart {
  createShape: (
    point:  { time: number; price?: number },
    options: Record<string, unknown>
  ) => string | null;
  createMultipointShape: (
    points:  Array<{ time: number; price: number }>,
    options: Record<string, unknown>
  ) => string | null;
  removeEntity:    (id: string) => void;
  setSymbol:       (symbol: string, interval: string, callback?: () => void) => void;
  resolution:      () => string;
  symbol:          () => string;
}

export interface TVWidget {
  onChartReady:    (cb: () => void) => void;
  activeChart:     () => TVChart;
  remove:          () => void;
  setSymbol:       (symbol: string, interval: string, callback?: () => void) => void;
  chart:           () => TVChart;
}

export {};
