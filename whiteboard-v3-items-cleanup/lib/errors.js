'use strict';
/** Outcomes shared by every server module: the Aborted error and cleanup.js exit codes. */

/** cleanup.js exit codes; run.sh maps them to its own 0 / 1 / 2. */
const EXIT_OK = 0;
const EXIT_ABORTED = 10;
const EXIT_ERROR = 20;

/** A check stopped the run on purpose; flow.items was not changed. */
class Aborted extends Error {}

module.exports = { Aborted, EXIT_ABORTED, EXIT_ERROR, EXIT_OK };
