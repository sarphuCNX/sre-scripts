'use strict';
/** Settings handed over by run.sh as WB_CLEANUP_* environment variables, validated. */

const PHASE_CHECK_EXPORT = 'check-export';
const PHASE_APPLY = 'apply';
const PHASES = [PHASE_CHECK_EXPORT, PHASE_APPLY];
const FLOW_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const SOURCE_COLLECTIONS = ['flowitems', 'flowitementryv3'];
const SYSTEM_COLLECTION_PREFIX = 'system.';

/**
 * Refuse a flowId that is not a plain id; it is used in a query and a file name.
 *
 * @param {string} flowId - the flowId.
 * @returns {string} the flowId, unchanged.
 * @throws {Error} if it has characters outside A-Z a-z 0-9 _ -.
 */
function validateFlowId(flowId) {
  if (!FLOW_ID_PATTERN.test(flowId)) {
    throw new Error(`flowId ${JSON.stringify(flowId)} may only contain letters, digits, '-' and '_'`);
  }
  return flowId;
}

/**
 * Refuse a backup collection that would write into live data or is not a valid name.
 *
 * @param {string} name - the configured collection name.
 * @returns {string} the name, unchanged.
 * @throws {Error} for flowitems, flowitementryv3, system.* or a name containing '$'.
 */
function validateBackupCollection(name) {
  if (SOURCE_COLLECTIONS.includes(name)) {
    throw new Error(`WB_CLEANUP_BACKUP_COLLECTION=${name} is a source collection; use a separate one`);
  }
  if (name.startsWith(SYSTEM_COLLECTION_PREFIX) || name.includes('$')) {
    throw new Error(`WB_CLEANUP_BACKUP_COLLECTION=${JSON.stringify(name)} is not a usable collection name`);
  }
  return name;
}

/**
 * Read and validate the settings for one phase.
 *
 * @param {object} env - process.env.
 * @returns {{phase: string, flowId: string, database: string, backupCollection: string,
 *   exportFile: string}} the settings.
 * @throws {Error} if a variable is missing or invalid.
 */
function readSettings(env) {
  const required = (name) => {
    const value = env[name];
    if (value === undefined || value === '') {
      throw new Error(`${name} is not set; run this through run.sh`);
    }
    return value;
  };
  const phase = required('WB_CLEANUP_PHASE');
  if (!PHASES.includes(phase)) {
    throw new Error(`unknown WB_CLEANUP_PHASE ${JSON.stringify(phase)}`);
  }
  return {
    phase,
    flowId: validateFlowId(required('WB_CLEANUP_FLOW_ID')),
    database: required('WB_CLEANUP_EFFECTIVE_DATABASE'),
    backupCollection: validateBackupCollection(required('WB_CLEANUP_BACKUP_COLLECTION')),
    exportFile: required('WB_CLEANUP_EXPORT_FILE'),
  };
}

module.exports = {
  PHASE_APPLY,
  PHASE_CHECK_EXPORT,
  readSettings,
  validateBackupCollection,
  validateFlowId,
};
