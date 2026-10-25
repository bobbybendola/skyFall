// Public forecast_score rows for a future scorecard panel.
// replay === true is a historical case and must not be shown as a live prediction.
// calibrated is true only when the official decay time is inside that forecast's 5–95% window.
import { useTable } from 'spacetimedb/react';
import { tables } from '../module_bindings/index.ts';

export function useForecastScores() {
  return useTable(tables.forecastScore);
}
