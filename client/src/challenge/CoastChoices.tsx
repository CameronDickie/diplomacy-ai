import { coastName, placeName } from './text.js';
import type { OrderEntry } from './useOrderEntry.js';

export function CoastChoices({ entry, disabled, onChoose }: { entry: OrderEntry; disabled: boolean; onChoose?: () => void }) {
  if (!entry.selectedUnit || !entry.coastChoices.length) return null;
  return <fieldset disabled={disabled} aria-label="Choose destination coast">
    <legend>Choose a coast for {placeName(entry.coastChoices[0].order.targetTerritory!)}</legend>
    {entry.coastChoices.map(option => <button type="button" key={option.id} onClick={() => {
      entry.choose(entry.selectedUnit!, option.id); entry.setSelected(null); onChoose?.();
    }}>{coastName(option.order.targetCoast!)} coast</button>)}
  </fieldset>;
}
