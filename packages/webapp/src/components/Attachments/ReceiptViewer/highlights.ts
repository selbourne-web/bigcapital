/** A highlight, as fractions (0-1) of the page as it is stored (unrotated). */
export interface Highlight {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Rotation = 0 | 90 | 180 | 270;

type Point = [number, number];

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** Where a point of the stored page shows once turned clockwise by `rotation`. */
const toDisplay = ([u, v]: Point, rotation: Rotation): Point => {
  switch (rotation) {
    case 90:
      return [1 - v, u];
    case 180:
      return [1 - u, 1 - v];
    case 270:
      return [v, 1 - u];
    default:
      return [u, v];
  }
};

/** The inverse of `toDisplay`. */
const toStored = ([x, y]: Point, rotation: Rotation): Point => {
  switch (rotation) {
    case 90:
      return [y, 1 - x];
    case 180:
      return [1 - x, 1 - y];
    case 270:
      return [1 - y, x];
    default:
      return [x, y];
  }
};

const rectFrom = ([x1, y1]: Point, [x2, y2]: Point): Highlight => ({
  x: Math.min(x1, x2),
  y: Math.min(y1, y2),
  w: Math.abs(x2 - x1),
  h: Math.abs(y2 - y1),
});

/**
 * Turns a rectangle drawn on the rotated page (fractions of what is shown)
 * into a highlight on the stored page, so it stays on the same words when
 * the page is turned again and when the marked-up copy is saved unrotated.
 */
export const highlightFromDisplay = (
  start: Point,
  end: Point,
  rotation: Rotation,
): Highlight =>
  rectFrom(
    toStored([clamp01(start[0]), clamp01(start[1])], rotation),
    toStored([clamp01(end[0]), clamp01(end[1])], rotation),
  );

/** Where a stored highlight shows on the page turned by `rotation`. */
export const highlightToDisplay = (
  highlight: Highlight,
  rotation: Rotation,
): Highlight =>
  rectFrom(
    toDisplay([highlight.x, highlight.y], rotation),
    toDisplay([highlight.x + highlight.w, highlight.y + highlight.h], rotation),
  );

export const HIGHLIGHT_FILL = 'rgba(255, 221, 0, 0.38)';
