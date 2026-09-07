/** @type {import("prettier").Config} */
export default {
  // Otherwise minimal: rely on Prettier 3 defaults for consistency.
  //
  // proseWrap "never" keeps each markdown paragraph on one line. Hard-wrapped
  // prose makes every edit reflow its whole paragraph, so diffs show a dozen
  // changed lines where one word moved, and a review cannot tell the two
  // apart. One line per paragraph means a wording change touches one line.
  proseWrap: "never",
};
