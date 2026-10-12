'use strict';
/** Entry point for cleanup.js: read settings, run one phase, turn the outcome into an exit code. */

const { Aborted, EXIT_ABORTED, EXIT_ERROR, EXIT_OK } = require('./errors.js');
const { PHASE_APPLY, PHASE_CHECK_EXPORT, readSettings } = require('./settings.js');
const { FlowStore } = require('./store.js');
const { apply, checkAndExport } = require('./phases.js');

const PHASE_RUNNERS = { [PHASE_CHECK_EXPORT]: checkAndExport, [PHASE_APPLY]: apply };

/**
 * Describe an unexpected error, pointing at the backup collection when a write may have begun.
 *
 * @param {*} error - what was thrown.
 * @param {object|null} settings - the settings, if they were read.
 * @returns {string} the message to print.
 */
function describeError(error, settings) {
  const reason = error && error.message ? error.message : String(error);
  if (!settings || settings.phase !== PHASE_APPLY) {
    return `error: ${reason}`;
  }
  return (
    `error: ${reason}. flow.items is cleared only as the last step; if this run stopped after ` +
    `the backup, re-running reuses the matching backup in ${settings.backupCollection}.`
  );
}

/**
 * Run the phase named in WB_CLEANUP_PHASE.
 *
 * @param {object} deps - {connection, env, fs, EJSON, print}; `connection` is a mongosh Mongo.
 * @returns {Promise<number>} EXIT_OK, EXIT_ABORTED or EXIT_ERROR.
 */
async function main({ connection, env, fs, EJSON, print }) {
  let settings = null;
  try {
    settings = readSettings(env);
    const store = new FlowStore(connection.getDB(settings.database), settings.backupCollection);
    await PHASE_RUNNERS[settings.phase]({ store, fs, EJSON, print }, settings);
    return EXIT_OK;
  } catch (error) {
    if (error instanceof Aborted) {
      print(`aborted: ${error.message}`);
      return EXIT_ABORTED;
    }
    print(describeError(error, settings));
    return EXIT_ERROR;
  }
}

module.exports = { main };
