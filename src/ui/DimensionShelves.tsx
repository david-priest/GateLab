// DimensionShelves.tsx — the "Arrange dimensions" shelves: each dimension a chip on one shelf,
// moved by dragging it onto another shelf or by its placement menu. Illustration places a figure's
// dimensions on rows, columns and pages with it; the Plotting tab places a chart's.

import type { ReactNode } from "react";
import "./figure.css";

export interface DimensionShelfChip {
  /** The dimension, as the shelves' owner names it. */
  id: string;
  /** Its name on the chip. */
  label: string;
  /** Its name in the chip's control labels ("Place {name}"); the id by default. */
  name?: string;
  /** Shown but not moved: no drag and no placement menu. */
  fixed?: boolean;
  /** Offers a button that takes the dimension off the shelves. */
  removable?: boolean;
}

export interface DimensionShelf {
  id: string;
  /** The shelf's heading. */
  label: ReactNode;
  chips: DimensionShelfChip[];
  /** Text or controls under the chips. */
  footer?: ReactNode;
}

export interface DimensionShelvesProps {
  shelves: DimensionShelf[];
  /** The placement menu's choices, every shelf a chip may go to. */
  places: { value: string; label: string }[];
  /** Whether a chip may go to a shelf; a choice it may not take is shown disabled. Everything by default. */
  canPlace?: (chip: string, shelf: string) => boolean;
  onPlace: (chip: string, shelf: string) => void;
  /** Offers a button that moves a chip one place earlier on its shelf. */
  onMoveEarlier?: (shelf: string, index: number) => void;
  onRemove?: (chip: string, shelf: string) => void;
  /** The drag data type, so a chip is only dropped on shelves of its own kind. */
  dragType: string;
}

export function DimensionShelves({ shelves, places, canPlace = () => true, onPlace, onMoveEarlier, onRemove, dragType }: DimensionShelvesProps) {
  const movable = new Set(shelves.flatMap((shelf) => shelf.chips.filter((chip) => !chip.fixed).map((chip) => chip.id)));
  return (
    <>
      {shelves.map((shelf) => (
        <div
          key={shelf.id}
          className="gl-figure-shelf"
          data-shelf={shelf.id}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const chip = e.dataTransfer.getData(dragType);
            if (movable.has(chip) && canPlace(chip, shelf.id)) onPlace(chip, shelf.id);
          }}
        >
          <h4>{shelf.label}</h4>
          {shelf.chips.map((chip, i) => {
            const name = chip.name ?? chip.id;
            return chip.fixed ? (
              <div className="gl-figure-dimension is-fixed" key={chip.id}>
                <span>{chip.label}</span>
              </div>
            ) : (
              <div
                className="gl-figure-dimension"
                key={chip.id}
                draggable
                onDragStart={(e) => e.dataTransfer.setData(dragType, chip.id)}
              >
                <span>{chip.label}</span>
                <select
                  aria-label={`Place ${name}`}
                  value={shelf.id}
                  onChange={(e) => onPlace(chip.id, e.target.value)}
                >
                  {places.map((place) => (
                    <option key={place.value} value={place.value} disabled={place.value !== shelf.id && !canPlace(chip.id, place.value)}>
                      {place.label}
                    </option>
                  ))}
                </select>
                {onMoveEarlier && (
                  <button
                    aria-label={`Move ${name} earlier`}
                    disabled={i === 0}
                    onClick={() => onMoveEarlier(shelf.id, i)}
                  >
                    ↑
                  </button>
                )}
                {chip.removable && onRemove && (
                  <button
                    aria-label={`Remove ${name}`}
                    onClick={() => onRemove(chip.id, shelf.id)}
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}
          {shelf.footer}
        </div>
      ))}
    </>
  );
}
