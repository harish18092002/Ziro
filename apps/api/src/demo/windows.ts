// The calendar the generated data was made with: Saturdays and Sundays off, the generator's fixed
// holidays, and its settlement lag. The rules must read the dates the way the data was generated or
// they would call a settlement late that was on time. A real merchant supplies their bank's calendar.
import { expandFixedHolidays } from '@ziro/core/time';
import { type PresetName, resolveConfig } from '@ziro/datagen';
import { DEFAULT_WINDOWS, type Windows } from '../common/verifier-config.js';

export function windowsFor(preset: PresetName, seed: number): Windows {
  const generated = resolveConfig(seed, preset);
  return {
    ...DEFAULT_WINDOWS,
    holidays: [...expandFixedHolidays(generated.fixedHolidays, 2020, 2035)].sort(),
    settlementLagBusinessDays: generated.settlementLagBusinessDays,
  };
}
