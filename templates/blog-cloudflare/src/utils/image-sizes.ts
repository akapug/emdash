/**
 * Content-column image slot geometry derived from `src/styles/tokens.css`
 * (`--content-width: 680px`, `--spacing-6: 1.5rem` = 24px each side -> 632px
 * inner column width; 48px total horizontal gutter).
 *
 * Shared by post cards (137g) and Portable Text body images (141b) so both
 * declare the template's real column width instead of falling back to 100vw
 * or the image's intrinsic file width in Safari and Firefox.
 */
export const CONTENT_COLUMN_MAX_PX = 680;
export const CONTENT_COLUMN_GUTTER_PX = 48;
export const CONTENT_COLUMN_INNER_PX = CONTENT_COLUMN_MAX_PX - CONTENT_COLUMN_GUTTER_PX;

export const POST_CARD_IMAGE_SIZES = `auto, (min-width: ${CONTENT_COLUMN_MAX_PX}px) ${CONTENT_COLUMN_INNER_PX}px, (min-width: 601px) calc(100vw - 3rem), calc(100vw - 2rem)`;
