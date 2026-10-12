'use strict';
/**
 * The two phases run.sh calls, one mongosh process each, with the confirmation in between:
 *   checkAndExport  check every precondition and write the export file (no database writes)
 *   apply           check the document still matches the export, back up, verify, clear
 */

const { Aborted } = require('./errors.js');
const { checkEligibility, sameFlowState, sameValue } = require('./checks.js');
const { readExport, writeExport } = require('./export-file.js');

const STATE_PREFIX = 'WB_STATE ';

/**
 * Read the flow, check it, and look for an existing backup.
 *
 * An existing backup holding exactly the current items is left over from an interrupted run
 * and is reused; any other backup stops the run.
 *
 * @param {{store: object, EJSON: object}} deps - database access and EJSON.
 * @param {string} flowId - the flow.
 * @param {{countAllV3Entries: boolean}} options - false to stop counting at the first entry.
 * @returns {Promise<{document: object, eligible: object, reusableBackup: object|null}>}
 * @throws {Aborted} if a precondition fails or a different backup exists.
 */
async function readEligibleFlow({ store, EJSON }, flowId, { countAllV3Entries }) {
  const documents = await store.findFlowDocuments(flowId);
  const v3EntryCount = await store.countV3Entries(flowId, countAllV3Entries ? {} : { limit: 1 });
  const eligible = checkEligibility(flowId, documents, v3EntryCount);
  const [document] = documents;
  const existingBackup = await store.findBackup(flowId);
  if (existingBackup && !sameValue(EJSON, existingBackup.items, document.flow.items)) {
    throw new Aborted(
      `${store.backupCollectionName} already holds a different backup for flowId ${flowId}; ` +
        'nothing was changed. Check that backup before removing it and re-running.'
    );
  }
  return { document, eligible, reusableBackup: existingBackup };
}

/**
 * Phase 1: check, export, and print the WB_STATE lines run.sh shows in its confirmation.
 *
 * @param {object} deps - {store, fs, EJSON, print}.
 * @param {{flowId: string, exportFile: string}} settings - the phase settings.
 * @returns {Promise<void>}
 * @throws {Aborted} if a check or the export fails.
 */
async function checkAndExport({ store, fs, EJSON, print }, { flowId, exportFile }) {
  const { document, eligible, reusableBackup } = await readEligibleFlow({ store, EJSON }, flowId, {
    countAllV3Entries: true,
  });
  writeExport({ fs, EJSON }, document, exportFile);
  if (reusableBackup) {
    print(
      `note: ${store.backupCollectionName} already holds a backup of exactly these items ` +
        '(from an interrupted run); it will be reused'
    );
  }
  print(`${STATE_PREFIX}ITEM_COUNT=${eligible.itemCount}`);
  print(`${STATE_PREFIX}V3_ENTRY_COUNT=${eligible.v3EntryCount}`);
  print(`${STATE_PREFIX}DOCUMENT_ID=${EJSON.stringify(eligible.documentId)}`);
  print(`${STATE_PREFIX}EXPORT_FILE=${exportFile}`);
}

/**
 * Back up the items, or reuse a backup that already holds exactly these items.
 *
 * @param {object} store - database access.
 * @param {string} flowId - the flow.
 * @param {object[]} items - flow.items as verified.
 * @param {object|null} reusableBackup - a matching backup from an interrupted run.
 * @returns {Promise<{backupId: *, insertedNow: boolean}>}
 */
async function backUpItems(store, flowId, items, reusableBackup) {
  if (reusableBackup) {
    return { backupId: reusableBackup._id, insertedNow: false };
  }
  await store.ensureBackupIndex();
  return { backupId: await store.insertBackup(flowId, items), insertedNow: true };
}

/**
 * Phase 2: refuse if the document changed since the export, back up, verify the backup on
 * the server, then clear flow.items. A backup this run inserted is removed again if the
 * verification or the clear fails, so flow.items and the backups stay consistent.
 *
 * @param {object} deps - {store, fs, EJSON, print}.
 * @param {{flowId: string, exportFile: string}} settings - the phase settings.
 * @returns {Promise<void>}
 * @throws {Aborted} if anything does not match; flow.items is then unchanged.
 */
async function apply({ store, fs, EJSON, print }, { flowId, exportFile }) {
  const exported = readExport({ fs, EJSON }, exportFile);
  const { document, eligible, reusableBackup } = await readEligibleFlow({ store, EJSON }, flowId, {
    countAllV3Entries: false,
  });
  if (!sameFlowState(EJSON, document, exported)) {
    throw new Aborted(
      'the flowitems document changed since it was exported; nothing was changed. Re-run.'
    );
  }

  const { backupId, insertedNow } = await backUpItems(
    store,
    flowId,
    document.flow.items,
    reusableBackup
  );
  const undoBackup = async () => {
    if (insertedNow) {
      await store.deleteBackup(backupId);
    }
  };

  const backedUp = await store.countBackupItems(backupId);
  if (backedUp !== eligible.itemCount) {
    await undoBackup();
    throw new Aborted(
      `backup holds ${backedUp} items, expected ${eligible.itemCount}; flow.items not changed`
    );
  }
  if (!(await store.clearItems(document))) {
    await undoBackup();
    throw new Aborted(
      'the flowitems document changed after it was read; flow.items not changed. ' +
        'Re-run to try again.'
    );
  }
  print(
    `flowId ${flowId}: cleared ${eligible.itemCount} items from flowitems.flow.items ` +
      `(backup in ${store.backupCollectionName}${insertedNow ? '' : ', reused'})`
  );
}

module.exports = { STATE_PREFIX, apply, checkAndExport };
