import { createContext, useContext } from "react";
import type { LabView, Summary } from "../../src/api-types";

export interface AppCtx {
  strategyId: string;
  setStrategyId: (id: string) => void;
  summary: Summary | null;
  lab: LabView | null;
  reload: () => void;
  /** Query string fragment selecting the strategy, e.g. "?strategy=cautious" or "" for the champion */
  q: (extra?: string) => string;
}
export const AppContext = createContext<AppCtx>({ strategyId: "", setStrategyId: () => undefined, summary: null, lab: null, reload: () => undefined, q: () => "" });
export const useApp = () => useContext(AppContext);
